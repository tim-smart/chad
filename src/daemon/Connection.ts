/** What a stored chat connection holds. A connection of kind `local` has no token. */
export interface Connection {
  /** The unique name, which tells two connections of one platform apart. */
  readonly name: string
  readonly kind: "discord" | "local"
  readonly token?: string | undefined
  /** The ids of the users who may talk to chad on this connection. */
  readonly owners: ReadonlyArray<string>
}
