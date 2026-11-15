// The real Discord, for the nightly Discord job: one bot's REST calls with its token, and the permissions a member
// has in a channel. Nothing on the pull request gate imports this file.
import { restRoot } from "./discord.ts"

/** A bot's REST client. A call that Discord refuses throws with the status and the body. */
export const bot = (token: string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    for (;;) {
      const response = await fetch(restRoot + path, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (response.status === 429) {
        const { retry_after } = await response.json()
        await new Promise((resolve) => setTimeout(resolve, retry_after * 1000))
        continue
      }
      const text = await response.text()
      if (!response.ok) {
        throw new Error(
          `Discord answered ${response.status} for ${method} ${path}: ${text}`,
        )
      }
      return text === "" ? undefined : JSON.parse(text)
    }
  }
  return {
    get: (path: string) => call("GET", path),
    post: (path: string, body: unknown) => call("POST", path, body),
    delete: (path: string) => call("DELETE", path),
  }
}

export type Bot = ReturnType<typeof bot>

/** Asks again once a second until `ready` gives a value. The test's own timeout is what ends the wait. */
export const eventually = async <A>(
  ready: () => Promise<A | undefined>,
): Promise<A> => {
  for (;;) {
    const value = await ready()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** One entry of a channel's permission overwrites, for a role or a member. */
export interface Overwrite {
  readonly id: string
  readonly allow: string
  readonly deny: string
}

/**
 * The permissions a member has in a channel, worked out as Discord's documentation does: the `@everyone` role and the
 * member's roles, then the channel's overwrites for `@everyone`, for the roles and for the member.
 */
export const permissionsIn = async (
  asker: Bot,
  guild: string,
  channel: { readonly permission_overwrites?: ReadonlyArray<Overwrite> },
  user: string,
): Promise<bigint> => {
  const roles: ReadonlyArray<{ id: string; permissions: string }> =
    await asker.get(`/guilds/${guild}/roles`)
  const member: { roles: ReadonlyArray<string> } = await asker.get(
    `/guilds/${guild}/members/${user}`,
  )
  const held = roles.filter(
    (role) => role.id === guild || member.roles.includes(role.id),
  )
  let permissions = held.reduce(
    (all, role) => all | BigInt(role.permissions),
    BigInt(0),
  )
  const apply = (overwrites: ReadonlyArray<Overwrite>) => {
    const deny = overwrites.reduce((all, o) => all | BigInt(o.deny), BigInt(0))
    const allow = overwrites.reduce(
      (all, o) => all | BigInt(o.allow),
      BigInt(0),
    )
    permissions = (permissions & ~deny) | allow
  }
  const overwrites = channel.permission_overwrites ?? []
  apply(overwrites.filter((overwrite) => overwrite.id === guild))
  apply(
    overwrites.filter(
      (overwrite) =>
        overwrite.id !== guild && member.roles.includes(overwrite.id),
    ),
  )
  apply(overwrites.filter((overwrite) => overwrite.id === user))
  return permissions
}
