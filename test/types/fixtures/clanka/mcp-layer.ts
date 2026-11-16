import { McpServers } from "clanka"

declare const config: Parameters<typeof McpServers.layer>[0]

export const layer = McpServers.layer(config)
