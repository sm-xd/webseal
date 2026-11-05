// Private channel between content.ts (isolated world) and main.ts (page world).
// main.ts creates a <webseal-channel> element and attaches it to the document;
// content.ts, injected in the same step before any page script, takes it out
// again. From then on only the two extension scripts hold a reference to it.
// The verdict is sent as the event type, the failure reason as the detail.

export type PageStatus = 'pending' | 'unknown' | 'ok' | 'fail';

export const CHANNEL_TAG = 'webseal-channel';
export const EV_HELLO = 'webseal:hello';
export const EV_STATUS_PREFIX = 'webseal:status:';
