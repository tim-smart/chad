// The Kubernetes checks of docs/spec/17-testing.md (TST-110): the probes, fsGroup on the cluster's volumes and the
// backup CronJob, run against a real cluster. They run by hand, once, on Tim's k3s node (TST-111), and never on the
// gate. The script applies deploy/kubernetes into a namespace of its own, checks what the cluster does with it, and
// deletes the namespace again with what it made, claims included.
//
//   node scripts/kubernetes.ts [--image <chad image>] [--asphodel <asphodel image>] [--keep]
//
// --image runs an image other than the one the manifests pin, such as one built from this branch and pushed. --keep
// leaves the namespace for a look. kubectl's current context is the cluster. The liveness check freezes chad and waits
// for the restart, so a run takes about five minutes.
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pinned = {
  chad: "ghcr.io/tim-smart/chad",
  asphodel: "ghcr.io/tim-smart/asphodel",
}

/** The value after a flag, or `undefined`. */
const option = (name: string) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

/** Runs kubectl, and fails with what it printed unless it exits 0 or `allowed` is set. */
const kubectl = (
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly allowed?: boolean } = {},
) => {
  const result = spawnSync("kubectl", args, {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && options.allowed !== true) {
    throw new Error(
      `kubectl ${args.join(" ")} exited ${result.status}\n${result.stdout}${result.stderr}`,
    )
  }
  return result
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

let failures = 0
const check = (name: string, passed: boolean, detail = "") => {
  if (!passed) failures++
  console.log(
    `${passed ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` (${detail})`}`,
  )
}
const note = (line: string) => console.log(`     ${line}`)

/** The manifests as kustomize renders them, with another image in place of a pinned one where one is given. */
export const rendered = (
  yaml: string,
  images: {
    readonly chad?: string | undefined
    readonly asphodel?: string | undefined
  },
) => {
  let out = yaml
  for (const [name, image] of Object.entries(images)) {
    if (image === undefined) continue
    const repository = pinned[name as keyof typeof pinned]
    out = out.replaceAll(
      new RegExp(`image: ${repository}(:\\S+)?`, "g"),
      `image: ${image}`,
    )
  }
  return out
}

/**
 * Freezes the daemon: the node process of `chad serve`. tini, PID 1, has arguments that end in `chad serve` as well,
 * and freezing it leaves chad answering, so the match is the node process's whole command line.
 */
export const freeze =
  "kill -STOP $(pgrep -x -f 'node /usr/local/bin/chad serve')"

interface Probe {
  readonly exec?: { readonly command: ReadonlyArray<string> }
  readonly periodSeconds?: number
  readonly timeoutSeconds?: number
  readonly failureThreshold?: number
}

const main = async () => {
  if (
    spawnSync("kubectl", ["version", "--client"], { stdio: "ignore" }).error !==
    undefined
  ) {
    console.error("missing tools: kubectl")
    return 1
  }
  const context = kubectl(["config", "current-context"]).stdout.trim()
  const namespace = `chad-check-${randomBytes(3).toString("hex")}`
  console.log(`cluster context ${context}, namespace ${namespace}`)
  const n = ["--namespace", namespace]
  kubectl(["create", "namespace", namespace])
  try {
    kubectl([
      ...n,
      "create",
      "secret",
      "generic",
      "chad-asphodel",
      `--from-literal=token=${randomBytes(32).toString("hex")}`,
    ])
    const yaml = rendered(
      kubectl(["kustomize", join(root, "deploy/kubernetes")]).stdout,
      { chad: option("--image"), asphodel: option("--asphodel") },
    )
    const tags = [...yaml.matchAll(/image: (\S+)/g)].map((match) => match[1])
    note(`images: ${[...new Set(tags)].join(", ")}`)
    kubectl([...n, "apply", "-f", "-"], { input: yaml })

    // The startup probe has to pass before the pod is ready, since there is no readiness probe.
    const rollout = kubectl(
      [...n, "rollout", "status", "deployment/chad", "--timeout=10m"],
      { allowed: true },
    )
    check(
      "the Deployment rolls out, which needs the startup probe to pass",
      rollout.status === 0,
    )
    const pod = () =>
      JSON.parse(
        kubectl([
          ...n,
          "get",
          "pod",
          "-l",
          "app.kubernetes.io/name=chad",
          "-o",
          "json",
        ]).stdout,
      ).items[0]
    const live = pod()
    const chad = live.spec.containers.find(
      (c: { name: string }) => c.name === "chad",
    )
    const liveness: Probe = chad.livenessProbe ?? {}
    const startup: Probe = chad.startupProbe ?? {}
    check(
      "IMG-76 the liveness probe runs chad health every 30 s, 5 s timeout, 3 failures",
      liveness.exec?.command.join(" ") === "chad health" &&
        liveness.periodSeconds === 30 &&
        liveness.timeoutSeconds === 5 &&
        liveness.failureThreshold === 3,
    )
    check(
      "IMG-77 the startup probe runs chad health every 2 s with 30 failures",
      startup.exec?.command.join(" ") === "chad health" &&
        startup.periodSeconds === 2 &&
        startup.failureThreshold === 30,
    )
    check(
      "IMG-78 chad has no readiness probe",
      chad.readinessProbe === undefined,
    )
    check(
      "IMG-87 the grace period is 90 s",
      live.spec.terminationGracePeriodSeconds === 90,
    )
    const health = kubectl(
      [...n, "exec", "deploy/chad", "-c", "chad", "--", "chad", "health"],
      {
        allowed: true,
      },
    )
    check(
      "chad health exits 0 in the pod",
      health.status === 0,
      health.stdout.trim(),
    )

    // fsGroup: on local-path the provisioner's directory is 0777 and fsGroup changes nothing, and chad still boots.
    const claim = JSON.parse(
      kubectl([...n, "get", "pvc", "chad-data", "-o", "json"]).stdout,
    )
    const volume = JSON.parse(
      kubectl(["get", "pv", claim.spec.volumeName, "-o", "json"]).stdout,
    )
    const provisioner =
      volume.metadata.annotations?.["pv.kubernetes.io/provisioned-by"] ??
      "unknown"
    const stat = kubectl([
      ...n,
      "exec",
      "deploy/chad",
      "-c",
      "chad",
      "--",
      "sh",
      "-c",
      "stat -c '%u:%g %a' /data; stat -f -c %T /data; stat -c '%u:%g' /data/db /data/repo",
    ])
      .stdout.trim()
      .split("\n")
    note(
      `chad-data: storage class ${claim.spec.storageClassName}, provisioner ${provisioner}`,
    )
    note(
      `/data owner and mode ${stat[0]}, filesystem ${stat[1]} (IMG-G16 asks for this)`,
    )
    if (provisioner === "rancher.io/local-path") {
      check(
        "IMG-104 on local-path fsGroup has no effect: /data is the provisioner's 0777 directory",
        stat[0]?.endsWith(" 777") === true,
        stat[0],
      )
    } else {
      check(
        "IMG-103 fsGroup 1000 gives /data to group 1000",
        stat[0]?.split(" ")[0]?.endsWith(":1000") === true,
        stat[0],
      )
    }
    check(
      "chad's own directories on the volume belong to uid 1000",
      stat.slice(2).every((line) => line.startsWith("1000:")),
      stat.slice(2).join(", "),
    )

    // The backup CronJob, with chad running and then with chad's pod down.
    const backup = (name: string) => {
      kubectl([...n, "create", "job", `--from=cronjob/chad-backup`, name])
      const waited = kubectl(
        [
          ...n,
          "wait",
          "--for=condition=complete",
          `job/${name}`,
          "--timeout=5m",
        ],
        { allowed: true },
      )
      const logs = kubectl([...n, "logs", `job/${name}`], {
        allowed: true,
      }).stdout.trim()
      return {
        passed:
          waited.status === 0 && /Backup written to \/backup\/chad-/.test(logs),
        logs,
      }
    }
    const running = backup("check-running")
    check(
      "IMG-108 the backup CronJob writes a tar while chad runs",
      running.passed,
      running.logs,
    )

    // asphodel's backup needs asphodel set up from its dashboard first, so its result is shown and not checked.
    kubectl([
      ...n,
      "create",
      "job",
      "--from=cronjob/asphodel-backup",
      "check-asphodel",
    ])
    const asphodel = kubectl(
      [
        ...n,
        "wait",
        "--for=condition=complete",
        "job/check-asphodel",
        "--timeout=2m",
      ],
      { allowed: true },
    )
    note(
      `asphodel-backup ${asphodel.status === 0 ? "completed" : "did not complete"}: ${kubectl([...n, "logs", "job/check-asphodel"], { allowed: true }).stdout.trim()}`,
    )

    // Liveness: a frozen chad is restarted by the probe and nothing else.
    const before = pod()
    const restarts = (p: {
      status: {
        containerStatuses: Array<{ name: string; restartCount: number }>
      }
    }) =>
      p.status.containerStatuses.find((c) => c.name === "chad")?.restartCount ??
      0
    kubectl([
      ...n,
      "exec",
      "deploy/chad",
      "-c",
      "chad",
      "--",
      "sh",
      "-c",
      freeze,
    ])
    const frozenAt = Date.now()
    const answering = kubectl(
      [...n, "exec", "deploy/chad", "-c", "chad", "--", "chad", "health"],
      { allowed: true },
    )
    check(
      "chad health fails once chad is frozen",
      answering.status !== 0,
      answering.stdout.trim(),
    )
    let restarted = false
    while (answering.status !== 0 && Date.now() - frozenAt < 5 * 60_000) {
      if (restarts(pod()) > restarts(before)) {
        restarted = true
        break
      }
      await sleep(5_000)
    }
    check(
      "IMG-76 REC-72 the liveness probe restarts a frozen chad",
      restarted,
      restarted
        ? `after ${Math.round((Date.now() - frozenAt) / 1000)} s`
        : "no restart in 5 minutes",
    )
    const back = kubectl(
      [...n, "rollout", "status", "deployment/chad", "--timeout=5m"],
      { allowed: true },
    )
    check("chad comes back after the restart", back.status === 0)

    kubectl([...n, "scale", "deployment/chad", "--replicas=0"])
    const gone = kubectl(
      [
        ...n,
        "wait",
        "--for=delete",
        "pod",
        "-l",
        "app.kubernetes.io/name=chad",
        "--timeout=3m",
      ],
      { allowed: true },
    )
    check("chad's pod is gone after the scale to 0", gone.status === 0)
    // A backup while the pod is still there would pass through its queue and prove nothing about a pod that is down.
    if (gone.status === 0) {
      const down = backup("check-down")
      check(
        "IMG-108 the backup CronJob writes a tar while chad's pod is down",
        down.passed,
        down.logs,
      )
    }
  } finally {
    if (process.argv.includes("--keep")) {
      console.log(`kept namespace ${namespace}`)
    } else {
      kubectl(
        ["delete", "namespace", namespace, "--wait=true", "--timeout=5m"],
        { allowed: true },
      )
    }
  }
  console.log(
    failures === 0 ? "all checks passed" : `${failures} checks failed`,
  )
  return failures === 0 ? 0 : 1
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main()
}
