/**
 * The title chad gives a thread it opens, from the message that opened it. It has a module of its own, with no
 * imports, because the fake model server answers a title request outside its script, by the prompt's first line.
 */

/** The first line of a title request. The message follows it. */
export const titleInstruction =
  "Write a short title for a chat thread that starts with the message below."

/** The longest title Discord takes for a thread. */
export const titleLength = 100

/** The one prompt of a title request: the instruction, the rules of the answer, and the message. */
export const titlePrompt = (message: string) =>
  [
    titleInstruction,
    "Answer with the title alone: at most six words, plain text, in the language of the message, with no quotes and no full stop at the end.",
    "",
    "Message:",
    message,
  ].join("\n")

/**
 * The title in a model's answer: its first line that is not blank, with no quotes, markup or full stop around it and
 * its spaces collapsed, cut to the longest title Discord takes. An answer with no such line has none.
 */
export const titleOf = (answer: string): string | undefined => {
  const line =
    answer
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  const title = line
    .replace(/^(?:title:|#+)\s*/i, "")
    .replace(/^["'`*_“”‘’]+|["'`*_“”‘’]+$/g, "")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, titleLength)
    .trim()
  return title === "" ? undefined : title
}
