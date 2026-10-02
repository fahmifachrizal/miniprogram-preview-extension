// The VS Code webview API (acquireVsCodeApi can only be called once per page)
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };
export const post = (msg) => api.postMessage(msg);
export const getState = () => api.getState() || {};
export const setState = (state) => api.setState(state);
