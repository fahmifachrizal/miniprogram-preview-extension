// Navigation helpers the analyzer should find as wrappers
export function go(name, id) {
  my.navigateTo({ url: `/pages/${name}/${name}?id=${id}` });
}
function go2(url, id) {
  my.navigateTo({ url: url + '?id=' + id });
}
// A wrapper of a wrapper
export const goOrder = (id) => go2('/sub/order/order', id);
export function toTab(path) {
  my.switchTab({ url: path });
}
export function openWith({ url }) {
  my.redirectTo({ url });
}

// Navigation functions by signature: one { url } object, not reaching my.* directly
export function routeTo({ url, animate }) {
  getApp().router.open(url, animate);
}
export function openPage(options) {
  getApp().router.open(options.url);
}
// Same shape, but an HTTP helper: not navigation
export function request({ url, data }) {
  my.request({ url, data });
}
