/**
 * Google Identity Servicesでのログイン、セッションのlocalStorage管理、
 * ログイン画面／スタブ画面の表示切り替えを行う。
 */
(function () {
  var STORAGE_PREFIX = 'kcb_trial_';
  var KEY_SESSION_TOKEN = STORAGE_PREFIX + 'sessionToken';
  var KEY_EXPIRES_AT = STORAGE_PREFIX + 'expiresAt';

  // Auth.gsのSESSION_TTL_MS（12時間）と同じ値。あくまで画面表示用の目安であり、
  // 実際の期限切れ判定はサーバーが返すAUTH_REQUIRED応答を正とする。
  var ADVISORY_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

  function safeGetItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeSetItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // ストレージ不可（プライベートブラウズ等）でも本処理は継続する
    }
  }

  function safeRemoveItem(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      // 失敗しても無視する
    }
  }

  function getStoredSession() {
    var token = safeGetItem(KEY_SESSION_TOKEN);
    if (!token) return null;
    var expiresAtRaw = safeGetItem(KEY_EXPIRES_AT);
    var expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null;
    return { sessionToken: token, expiresAt: isNaN(expiresAt) ? null : expiresAt };
  }

  function saveSession(sessionToken) {
    var expiresAt = Date.now() + ADVISORY_SESSION_TTL_MS;
    safeSetItem(KEY_SESSION_TOKEN, sessionToken);
    safeSetItem(KEY_EXPIRES_AT, String(expiresAt));
  }

  function clearSession() {
    safeRemoveItem(KEY_SESSION_TOKEN);
    safeRemoveItem(KEY_EXPIRES_AT);
  }

  // ==== 画面表示 ====
  function showLoading(visible) {
    document.getElementById('loadingOverlay').hidden = !visible;
  }

  function showLoginOverlay() {
    document.getElementById('mainScreen').hidden = true;
    document.getElementById('loginOverlay').hidden = false;
  }

  function hideMainScreen() {
    document.getElementById('mainScreen').hidden = true;
  }

  function showLoginError(code) {
    var el = document.getElementById('loginError');
    el.textContent = window.KCB_MESSAGES.textFor(code);
    el.hidden = false;
  }

  function clearLoginError() {
    var el = document.getElementById('loginError');
    el.textContent = '';
    el.hidden = true;
  }

  // ログイン期限切れ等、ユーザーが再ログインするまで残したい表示のため、自動では消えないバナーを使う
  function showBanner(text) {
    if (window.KcbBanner) window.KcbBanner.showPersistent(text);
  }

  function hideBanner() {
    if (window.KcbBanner) window.KcbBanner.hide();
  }

  function showMainScreen(bootstrap, expiresAt) {
    hideBanner();
    clearLoginError();
    document.getElementById('loginOverlay').hidden = true;
    document.getElementById('mainScreen').hidden = false;
    if (window.KcbAuth.onBootstrapReady) window.KcbAuth.onBootstrapReady(bootstrap, expiresAt);
  }

  // ==== セッション切れ（call実行中にAUTH_REQUIREDを受けた場合。gas-shim.jsから呼ばれる） ====
  // trueの間にログインが成功した場合、ボードの再初期化ではなくページ再読み込みで最初からやり直す
  // （board.jsはページ内で既に初期化済みの可能性があり、再初期化するとイベント登録等が二重になるため）
  var sessionExpiredPending_ = false;

  function handleSessionExpired() {
    sessionExpiredPending_ = true;
    clearSession();
    hideMainScreen();
    showLoginOverlay();
    showBanner(window.KCB_MESSAGES.textFor('AUTH_REQUIRED'));
  }

  // ==== ログイン後のブートストラップ取得 ====
  function loadBootstrapAndShowMain() {
    var stored = getStoredSession();
    return window.KcbGas.callGas('getBootstrap').then(function (bootstrap) {
      showMainScreen(bootstrap, stored ? stored.expiresAt : null);
    });
  }

  // ==== GIS（Google Identity Services）====
  function handleCredentialResponse(response) {
    var idToken = response && response.credential;
    clearLoginError();
    showLoading(true);

    window.KcbGas.postToGas('login', { idToken: idToken })
      .then(function (res) {
        idToken = null; // 送信済みのIDトークンはここで参照を切り、以後保持・表示しない
        if (!res.ok) {
          showLoginError(res.code);
          return;
        }
        saveSession(res.result.sessionToken);
        if (sessionExpiredPending_) {
          location.reload();
          return;
        }
        return loadBootstrapAndShowMain();
      })
      .catch(function (err) {
        idToken = null;
        showLoginError(err && err.code);
      })
      .finally(function () {
        showLoading(false);
      });
  }

  function initGoogleSignIn() {
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      showLoginError('SERVER_ERROR');
      return;
    }
    google.accounts.id.initialize({
      client_id: window.KCB_CONFIG.CLIENT_ID,
      ux_mode: 'popup',
      callback: handleCredentialResponse
    });
    google.accounts.id.renderButton(
      document.getElementById('googleSignInButton'),
      { type: 'standard' }
    );
  }

  // ==== ログアウト ====
  function logout() {
    var stored = getStoredSession();
    clearSession();

    if (window.google && google.accounts && google.accounts.id) {
      try {
        google.accounts.id.disableAutoSelect();
      } catch (e) {
        // 失敗しても無視する（ログアウト自体は継続する）
      }
    }

    hideMainScreen();
    showLoginOverlay();

    if (stored && stored.sessionToken) {
      window.KcbGas.postToGas('logout', { sessionToken: stored.sessionToken }).catch(function () {
        // ログアウトはベストエフォート。通信に失敗してもローカルの状態は既にクリア済み
      });
    }
  }

  // 他タブでログアウト（localStorage削除）された場合、このタブも追従する
  window.addEventListener('storage', function (e) {
    if (e.key === KEY_SESSION_TOKEN && !e.newValue) {
      hideMainScreen();
      showLoginOverlay();
    }
  });

  // ==== 初期化 ====
  function init() {
    window.KcbGas.getSessionToken = function () {
      var s = getStoredSession();
      return s ? s.sessionToken : null;
    };
    window.KcbGas.onSessionExpired = handleSessionExpired;

    initGoogleSignIn();

    var stored = getStoredSession();
    if (!stored || !stored.sessionToken) {
      showLoginOverlay();
      return;
    }

    showLoading(true);
    window.KcbGas.callGas('getBootstrap')
      .then(function (bootstrap) {
        showMainScreen(bootstrap, stored.expiresAt);
      })
      .catch(function (err) {
        // AUTH_REQUIREDはcallGas内部のonSessionExpiredで既に処理済み。
        // それ以外（FORBIDDEN等、アカウント自体が使えなくなった場合）もローカルの状態をクリアする。
        if (err && err.code === 'FORBIDDEN') {
          clearSession();
        }
        showLoginOverlay();
        showBanner(window.KCB_MESSAGES.textFor(err && err.code));
      })
      .finally(function () {
        showLoading(false);
      });
  }

  window.KcbAuth = {
    init: init,
    logout: logout,
    // 段階2-3b: ログイン成功時にapp.jsが差し替える（board.jsの起動フック）
    onBootstrapReady: null
  };
})();
