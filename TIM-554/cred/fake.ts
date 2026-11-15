// PROTOTYPE (TIM-554). Every secret here is invented for this run and belongs to no account.
import { base32Encode } from "./chad/secrets.ts"

const seed = base32Encode(Buffer.from("fake-totp-seed-00003"))
export const FAKE = {
  user: "tim",
  password: "FAKE-pw-not-real-0001",
  /** A value with a quote, a backslash and an apostrophe in it. */
  quoted: "FAKE\"pw\\not'real-0002",
  /** The seed in canonical base32, and the way an owner would type it: lower case, in groups of four. */
  totp: seed,
  totpTyped: seed.toLowerCase().replace(/(.{4})/g, "$1 ").trim(),
  tiny: "abc123",
  /** The password the secret is changed to while a login is in progress. */
  password2: "FAKE-pw-not-real-0004",
  apiKey: "FAKE-key-not-real-0005",
  /** A password the owner pastes into the chat before it is stored. */
  pasted: "FAKE-pasted-pw-0010",
  /** A value a dotenv parser reads as a value and a comment. */
  hashy: "FAKE pw #not real 0009"
}
