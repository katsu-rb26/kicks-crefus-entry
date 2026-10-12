/**
 * クリックジャッキング対策（フレーム外判定）と、画面全体の初期化の配線を行う。
 * ログイン成功後にauth.jsから受け取ったbootstrapでboard.jsの初期化を起動する。
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

// ログイン成功（getBootstrap完了）後にauth.jsから呼ばれる。ログイン前はboard.jsを初期化しない。
window.KcbAuth.onBootstrapReady = function (bootstrap) {
  window.KcbBoard.init(bootstrap);
};

document.addEventListener('DOMContentLoaded', function () {
  var logoutButton = document.getElementById('logoutButton');
  if (logoutButton) {
    logoutButton.addEventListener('click', function () {
      window.KcbAuth.logout();
    });
  }
  window.KcbAuth.init();
});
