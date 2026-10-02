import { go, goOrder, toTab, openWith, routeTo, openPage, request } from '../../utils/nav';
const LIST = '/pages/list/list';
Page({
  data: {},
  onLoad() {},
  onTapDetail(e) { go('detail', e.id); },
  openList() { my.navigateTo({ url: LIST }); },
  openRelative() { my.navigateTo({ url: '../detail/detail?from=index' }); },
  openDynamic(e) { my.navigateTo({ url: e.target.dataset.url }); },
  toCart() { toTab('/pages/cart/cart'); },
  reset() { my.reLaunch({ url: '/pages/index/index' }); },
  order(e) { goOrder(e.id); },
  helper() { this.openList(); },
  custom() { myRouter.push('/pages/profile/index'); },
  profileShort() { my.navigateTo({ url: '/pages/profile' }); },
  withOptions() { openWith({ url: '/pages/list/list' }); },
  later() {
    my.request({ url: 'https://example.com', success: () => my.navigateTo({ url: '/pages/cart/cart' }) });
  },
  goRoute() { routeTo({ url: '/pages/cart/cart', animate: true }); },
  goOptions() { openPage({ url: '../list/list' }); },
  goRouteDynamic(e) { routeTo({ url: e.detail.url }); },
  loadData() { request({ url: 'https://example.com/api' }); },
  npmRouter() { router.go({ url: '/pages/detail/detail' }); },
  track() { tracker.send({ url: 'https://log.example.com' }); },
});
