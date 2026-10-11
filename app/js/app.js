/**
 * クリックジャッキング対策（フレーム外判定）と、画面全体の初期化の配線のみを行う。
 * 本画面の移植は段階2-3で行うため、ここではスタブ画面の表示に必要な配線だけを持つ。
 */
(function () {
  // フレーム外で開かれていると判定できるまで、body(CSS側でdisplay:noneの既定)は表示しない。
  var isTop;
  try {
    isTop = window.top === window.self;
  } catch (e) {
    isTop = false;
  }
  if (isTop) {
    document.body.classList.add('kcb-visible');
  }
})();

document.addEventListener('DOMContentLoaded', function () {
  var logoutButton = document.getElementById('logoutButton');
  if (logoutButton) {
    logoutButton.addEventListener('click', function () {
      window.KcbAuth.logout();
    });
  }
  window.KcbAuth.init();
});
