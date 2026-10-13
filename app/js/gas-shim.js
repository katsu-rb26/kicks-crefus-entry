/**
 * GASのdoPost JSON API（action: login/logout/call）へのフェッチと、
 * google.script.run互換のProxyチェーンを提供する。
 * 段階1のCode.gs側 API_WHITELIST_ と、このWHITELISTは常に完全一致させること
 * （どちらかに関数を追加・削除したら、もう片方も必ず更新する）。
 */
(function () {
  var TIMEOUT_MS = 30000;

  var WHITELIST = [
    'getSchoolList', 'getMediaList', 'getStaffNameList', 'getStatusList', 'getResultList',
    'getCourseList', 'getMarkOptions', 'getAreaList', 'getSchoolAreaMap', 'getRecords',
    'getRawTextsBulk', 'updateRecord', 'parseInquiryText', 'registerRecord', 'updateRecordFields',
    'deleteRecords', 'getDashboardData', 'saveEnrollmentInputs', 'getMasterListNames', 'getMasterListData',
    'getTrashRecords', 'restoreFromTrash', 'permanentlyDeleteFromTrash', 'saveMasterListData', 'getBootstrap',
    'getSpamHoldList', 'getSpamHoldQuestionFull', 'getSpamHoldCounts', 'importSpamHold', 'discardSpamHold'
  ];

  function makeError(code, message) {
    var err = new Error(message || code);
    err.code = code;
    return err;
  }

  // login/logout/call共通の下位送信処理。トークンはURLに載せず、本文（JSON）にのみ入れる。
  function postToGas(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    return fetch(window.KCB_CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw makeError('SERVER_ERROR', 'サーバー応答の解析に失敗しました');
        }
      });
    }).catch(function (err) {
      if (err && err.code) throw err;
      if (err && err.name === 'AbortError') throw makeError('TIMEOUT', 'タイムアウトしました');
      throw makeError('NETWORK', '通信に失敗しました');
    }).finally(function () {
      clearTimeout(timeoutId);
    });
  }

  // ホワイトリスト外は送信自体を行わず、ローカルでBAD_REQUEST相当として失敗させる
  function callGas(fn, args) {
    if (WHITELIST.indexOf(fn) === -1) {
      return Promise.reject(makeError('BAD_REQUEST', '未許可の関数です: ' + fn));
    }

    var sessionToken = window.KcbGas.getSessionToken();
    return postToGas('call', { sessionToken: sessionToken, fn: fn, args: args || [] })
      .then(function (res) {
        if (!res || typeof res !== 'object') throw makeError('SERVER_ERROR');
        if (!res.ok) {
          if (res.code === 'AUTH_REQUIRED') window.KcbGas.onSessionExpired();
          throw makeError(res.code || 'SERVER_ERROR', res.message);
        }
        return res.result;
      });
  }

  // google.script.run互換のProxyチェーン（段階3で本画面に使う想定。ここでは骨組みのみ）
  function buildScriptRunProxy(successHandler, failureHandler, userObject) {
    return new Proxy({}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (cb) { return buildScriptRunProxy(cb, failureHandler, userObject); };
        }
        if (prop === 'withFailureHandler') {
          return function (cb) { return buildScriptRunProxy(successHandler, cb, userObject); };
        }
        if (prop === 'withUserObject') {
          return function (obj) { return buildScriptRunProxy(successHandler, failureHandler, obj); };
        }
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callGas(prop, args).then(function (result) {
            if (successHandler) successHandler(result, userObject);
          }).catch(function (err) {
            // AUTH_REQUIREDはcallGas内でonSessionExpired()が既にログイン画面＋バナー表示を行っている。
            // ここでさらにfailureHandler（alert等）を呼ぶとログイン画面の上にエラー表示が重なるため呼ばない
            if (err && err.code === 'AUTH_REQUIRED') return;
            if (failureHandler) {
              failureHandler(err.message, userObject);
            } else {
              window.KcbGas.onDefaultFailure(err);
            }
          });
        };
      }
    });
  }

  window.KcbGas = {
    WHITELIST: WHITELIST,
    // auth.jsが起動時に実体を差し替える（ここでのデフォルトは未ログイン相当）
    getSessionToken: function () { return null; },
    onSessionExpired: function () {},
    onDefaultFailure: function (err) {
      console.error('[KcbGas] 既定の失敗ハンドラ:', err && err.code);
    },
    postToGas: postToGas,
    callGas: callGas,
    scriptRun: buildScriptRunProxy(null, null, null)
  };
})();
