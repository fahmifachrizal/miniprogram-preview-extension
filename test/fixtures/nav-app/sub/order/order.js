import * as nav from '../../utils/nav';

Page({
  onLoad() {},
  toList() { my.navigateTo({ url: '../../pages/list/list' }); },
  toCart() { nav.toTab('/pages/cart/cart'); },
});
