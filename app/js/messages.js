/**
 * errorCode → 日本語の文言。
 * サーバー（GAS）はerrorCodeだけを返す前提で、文言はすべてこちらで持つ。
 * Auth.gs / Code.gs 側がmessageを付けて返す場合があるが、画面表示では使わずcodeだけで判定する。
 */
(function () {
  var MESSAGES = {
    AUTH_REQUIRED: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    FORBIDDEN: 'このアカウントでは使えません。登録済みのGoogleアカウントでログインしているか確認してください。',
    BAD_REQUEST: 'リクエストの内容が正しくありません。',
    SERVER_ERROR: 'サーバーでエラーが発生しました。しばらくしてから再度お試しください。',
    TOO_MANY_REQUESTS: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
    NETWORK: '通信に失敗しました。ネットワーク環境を確認してください。',
    TIMEOUT: '通信がタイムアウトしました。もう一度お試しください。'
  };
  var DEFAULT_MESSAGE = '予期しないエラーが発生しました。';

  window.KCB_MESSAGES = {
    textFor: function (code) {
      return MESSAGES[code] || DEFAULT_MESSAGE;
    }
  };
})();
