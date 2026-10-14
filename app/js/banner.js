/**
 * 画面上端固定の失敗バナー(#globalErrorBanner)の表示・非表示を一元管理する。
 * board.js（操作失敗時）とauth.js（セッション切れ等）の両方から、この窓口経由でのみ操作する。
 */
(function () {
  var AUTO_HIDE_MS = 5000;
  var autoHideTimer = null;

  function clearAutoHideTimer_() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }

  function show_(text) {
    var el = document.getElementById('globalErrorBanner');
    var textEl = document.getElementById('globalErrorBannerText');
    if (textEl) textEl.textContent = text;
    if (el) el.classList.remove('isHidden');
  }

  function hide() {
    clearAutoHideTimer_();
    var el = document.getElementById('globalErrorBanner');
    if (el) el.classList.add('isHidden');
  }

  // 操作失敗など、一定時間で自動的に消えてよい表示。連続して呼ばれた場合は
  // 新しい文言に置き換え、自動で消えるまでの時間も数え直す
  function showAutoDismiss(text) {
    clearAutoHideTimer_();
    show_(text);
    autoHideTimer = setTimeout(hide, AUTO_HIDE_MS);
  }

  // ログイン期限切れなど、ユーザーが操作（再ログイン）するまで残したい表示。自動では消えない
  function showPersistent(text) {
    clearAutoHideTimer_();
    show_(text);
  }

  var closeBtn = document.getElementById('globalErrorBannerCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', hide);

  window.KcbBanner = {
    showAutoDismiss: showAutoDismiss,
    showPersistent: showPersistent,
    hide: hide
  };
})();
