/** Route and namespace constants shared by the Host service and the browser page. */

/** Typert remote namespace; the browser reaches it via `ctx.get('remote.chatMode')`. */
export const REMOTE_NAMESPACE = 'chatMode'

/** Absolute route below `/api` that accepts one chat turn (phase 2: streaming). */
export const CHAT_TURN_PATH = '/api/dsh-chat-mode/turn'

/** Browser-relative form of {@link CHAT_TURN_PATH}. */
export const CHAT_TURN_ROUTE = CHAT_TURN_PATH.slice(1)
