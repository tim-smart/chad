const { Effect } = require("effect")
const { hello } = require("words")

exports.greet = (name) => Effect.succeed(`${hello} ${name}`)
