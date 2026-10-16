export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}
