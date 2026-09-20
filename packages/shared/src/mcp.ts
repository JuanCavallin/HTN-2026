import type { Iso } from './domain.js';

export type McpConnectionStatus = 'connected' | 'error' | 'disabled';

/**
 * Persisted configuration for one user-added upstream MCP server.
 * `headerEnv` maps HTTP header names to environment-variable names; secret
 * values never enter the database or API response.
 */
export interface McpConnection {
  id: string;
  name: string;
  url: string;
  transport: 'streamable_http';
  enabled: boolean;
  headerEnv: Record<string, string>;
  status: McpConnectionStatus;
  toolIds: string[];
  executableToolIds: string[];
  lastError?: string;
  lastRefreshedAt?: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateMcpConnectionInput {
  name: string;
  url: string;
  enabled?: boolean;
  headerEnv?: Record<string, string>;
}
