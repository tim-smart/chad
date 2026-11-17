/**
 * The one short fixed prompt of the check at start and of a trial request. The model reads it. It has
 * a module of its own, with no imports, because the fake model server answers it outside its script and the second
 * container's bundle of the fakes must not take in what `Messages` imports.
 */
export const modelTrial = "Reply with the single word ok."
