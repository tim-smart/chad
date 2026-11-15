// The one scale factor of the tests' lengths, in a file of its own. It imports nothing, so the fakes of the image
// layer's second container, which use it too, bundle without the daemon's entry (test/support/second.ts).

/** The one scale factor. The 60 seconds of a stop become 3, and the orderings between the lengths hold. */
export const factor = 0.05
