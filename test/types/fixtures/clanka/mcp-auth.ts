import { McpServers } from "clanka"

declare const config: Parameters<typeof McpServers.layer>[0]
declare const authProvider: McpServers.AuthProviderFor

export const withoutLogin = McpServers.layer(config)
export const withLogin = McpServers.layer(config, authProvider)
