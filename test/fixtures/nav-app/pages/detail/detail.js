Page({
  onLoad(query) {},
  goBack() { my.navigateBack(); },
  replace() { my.redirectTo({ url: '/pages/list/list' }); },
});
