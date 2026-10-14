    // 段階2-3b: 旧GASテンプレート変数(fiscalYear/userName/userAreasJson/isMasterAdmin)は
    // getBootstrap()の戻り値から、ログイン成功後にinit(bootstrap)の中で設定する
    let CURRENT_USER_AREAS = []; // プライマリ→2番目→3番目の順
    let IS_MASTER_ADMIN = false; // マスタ管理タブの編集UI表示可否（実際の権限判定はサーバー側で必須）

    let dashboardLoaded = false;
    let lastDashboardData = null; // KPIグラフ描画用に最新の集計データを保持
    let dashboardChartInstance = null; // Chart.jsのインスタンス（切り替え時にdestroyしてから再生成）
    let currentKpiChartType_ = null; // 'weeklyTrend' | 'kcTrend' | 'rateCompare' | 'mediaPie'
    let rateCompareScope_ = 'school'; // 実施率／入会率比較の表示単位（'school' | 'area'）
    let masterTabLoaded = false;
    let mediaList = [];
    let staffList = [];
    let statusList = [];
    let resultList = [];
    let courseList = [];
    let markOptions = []; // [{emoji, label}]
    let areaList = [];
    let schoolAreaMap = {}; // { 教室名: エリア }
    let currentAreaFilter = ''; // '' = 全エリア
    let schoolList = [];
    const timeOptions = buildTimeOptions_();

    let recordCache = {}; // No をキーに、編集モーダル/ホバーポップアップ用に最新レコードを保持
    let rawTextCache = {}; // No をキーに、元メール本文をキャッシュ（一覧表示後にバックグラウンドで取得）
    let currentMasterColumns = [];

    // 保留メール（営業の疑い）確認: 件数はダッシュボード・エリアタブ・一覧上のバナーが共有する
    let spamHoldCountsLoaded_ = false; // getSpamHoldCountsが一度も成功していない間は、カード・バッジ・バナーを一切出さない
    let spamHoldCounts_ = { total: 0, byArea: {} };
    let spamHoldList_ = []; // 確認パネルを開いた時点のgetSpamHoldList結果（area列でクライアント側絞り込み）
    let spamHoldQuestionFullCache_ = {}; // 保留ID -> ご質問欄全文（「本文を表示」の再取得を避けるため）

    function init(bootstrap) {
      CURRENT_USER_AREAS = bootstrap.userAreas || [];
      IS_MASTER_ADMIN = !!bootstrap.isMasterAdmin;
      document.getElementById('boardFiscalYear').textContent = bootstrap.fiscalYear || '';
      document.getElementById('boardUserName').textContent = bootstrap.userName || '';
      startSplashSequence_();

      loadInitialMasters_();

      populateSelectOptions_('edit-KicksCrefus', ['', 'Kicks', 'crefus'], '（要確認）');
      populateSelectOptions_('edit-時間', timeOptions, '(未選択)');
      populateSelectOptions_('register-KicksCrefus', ['', 'Kicks', 'crefus'], '（要確認）');
      populateSelectOptions_('register-新学年', ['', '年中', '年長', '小1', '小2', '小3', '小4', '小5', '小6', '中1', '中2', '中3'], '(未選択)');
      populateSelectOptions_('register-時間時', buildHourOptions_(), '(未選択)');
      populateSelectOptions_('register-時間分', ['', '00', '15', '30', '45'], '(未選択)');

      setupModalHandlers_();
      setupHoverPopups_();
      updateSortArrow_();
      updateOnlySelectedButton_(); // 初回表示時点でスマホ幅なら短縮文言を反映
      setupMasterAdminUi_();

      // 画面回転・ウィンドウ幅変更時、開いているKPIグラフの再描画と「選択のみ表示」ボタンの文言を更新
      let resizeTimer_;
      window.addEventListener('resize', function () {
        clearTimeout(resizeTimer_);
        resizeTimer_ = setTimeout(function () {
          if (isModalOpen_('chartModalOverlay') && currentKpiChartType_) renderKpiChart_();
          updateOnlySelectedButton_();
        }, 200);
      });
    }

    // google.script.run形式の呼び出しをPromiseで包む小さなヘルパー。
    // window.KcbGas.callGas自体が既にPromiseを返す仕組みなので、関数名と引数を渡すだけの薄いラッパー
    // （gas-shim.js自体は変更しない。失敗時はcode/messageを保ったErrorがそのままrejectされる）
    function callGasAsync_(fnName, args) {
      return window.KcbGas.callGas(fnName, args || []);
    }

    // withFailureHandlerに渡るeは現状、gas-shim.jsが文字列（message）として渡すが、
    // code/messageを持つオブジェクトが渡される場合にも対応できるようにしておく。
    // code優先→message→汎用文言の順でユーザー向け文言を返す。
    function gasErrorText_(e) {
      if (!e) return window.KCB_MESSAGES.textFor();
      if (typeof e === 'string') return e;
      if (e.code) return window.KCB_MESSAGES.textFor(e.code);
      if (e.message) return e.message;
      return window.KCB_MESSAGES.textFor();
    }

    function showGlobalError_(text) {
      const el = document.getElementById('globalErrorBanner');
      if (el) { el.textContent = text; el.hidden = false; }
    }

    function hideGlobalError_() {
      const el = document.getElementById('globalErrorBanner');
      if (el) el.hidden = true;
    }

    // ==== 書き込み系ボタンの「処理中」表示（共通） ====
    // 範囲(scopeKey)ごとに実行中フラグを持ち、同じ範囲内のボタンをまとめて押せなくする。
    // 二重実行はdisabled属性だけでなくこのフラグでも防ぐ（Enterキー等での連打対策）。
    const busyScopes_ = {}; // scopeKey -> boolean

    function isScopeBusy_(scopeKey) {
      return !!busyScopes_[scopeKey];
    }

    // scopeKey: 同じ範囲の全ボタンをまとめて押せなくする単位の識別子
    // scopeButtons: その範囲内で、処理中は押せなくするボタン要素の配列（nullは無視）
    // triggerBtn: 実際に押されたボタン（スピナー＋文言に変える対象）。nullなら文言変更なし
    // busyText: 処理中に表示する文言（例: '保存中…'）
    // taskFn: サーバー呼び出しを含むPromiseを返す関数
    // 戻り値: taskFn()のPromise（既にscopeKeyが処理中の場合は何もせずresolve済みPromiseを返す）
    function withBusy_(scopeKey, scopeButtons, triggerBtn, busyText, taskFn) {
      if (isScopeBusy_(scopeKey)) return Promise.resolve();
      busyScopes_[scopeKey] = true;

      const originalText = triggerBtn ? triggerBtn.textContent : null;
      scopeButtons.forEach(function (btn) { if (btn) btn.disabled = true; });
      if (triggerBtn) {
        triggerBtn.classList.add('isBusy');
        triggerBtn.textContent = '';
        const spinner = document.createElement('span');
        spinner.className = 'kcbSpinner';
        triggerBtn.appendChild(spinner);
        triggerBtn.appendChild(document.createTextNode(busyText));
      }

      return taskFn().finally(function () {
        busyScopes_[scopeKey] = false;
        scopeButtons.forEach(function (btn) { if (btn) btn.disabled = false; });
        if (triggerBtn) {
          triggerBtn.classList.remove('isBusy');
          triggerBtn.textContent = originalText;
        }
      });
    }

    // 連絡済みチェック用：チェックボックスの右側に、スピナー付きの小さな「保存中」バッジを表示する。
    // 行ごとに独立した要素をposition:fixedでbodyへ追加する（table側のoverflow:hiddenで隠れないようにするため）
    function showContactCheckBusy_(checkboxEl) {
      const badge = document.createElement('div');
      badge.className = 'contactCheckBusyBadge';
      const spinner = document.createElement('span');
      spinner.className = 'kcbSpinner';
      badge.appendChild(spinner);
      badge.appendChild(document.createTextNode('保存中'));
      document.body.appendChild(badge);

      const rect = checkboxEl.getBoundingClientRect();
      badge.style.left = (rect.right + 4) + 'px';
      badge.style.top = (rect.top - 4) + 'px';
      return badge;
    }

    function hideContactCheckBusy_(badge) {
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    }

    // 媒体・担当者・状況・結果・コース・マーク・エリア一覧・教室エリア対応の選択肢（マスタ系9本）を
    // 並列取得する。従来はmastersLoadedCountのカウンタで「8本そろったら一覧を読む」としていたが、
    // Promise.allにまとめて置き換える。
    // 挙動の変更点：
    //  - getSchoolListは従来、一覧表示(getRecords)の待ち合わせに入っていなかった（成功/失敗どちらでも
    //    カウンタに影響しなかった）。Promise.allでは9本すべての成功を待つため、getSchoolListの失敗も
    //    一覧表示をブロックするようになる
    //  - 従来は各マスタ取得が失敗してもmasterLoaded_()が呼ばれ続け、結果的に一覧表示(getRecords)は
    //    常に実行されていた（失敗はconsole.errorのみでユーザーには見えなかった）。
    //    Promise.allではいずれか1本でも失敗すると一覧表示を行わず、画面にエラーメッセージを表示する
    function loadInitialMasters_() {
      hideGlobalError_();
      return Promise.all([
        callGasAsync_('getSchoolList').then(function (list) {
          schoolList = list || [];
          populateSchoolFilter(schoolList);
          populateSelectOptions_('register-教室名', [''].concat(schoolList), '(未選択)');
        }),
        callGasAsync_('getMediaList').then(function (list) {
          mediaList = list || [];
          populateSelectOptions_('edit-媒体', [''].concat(mediaList), '(未選択)');
          populateSelectOptions_('register-媒体', [''].concat(mediaList), '(未選択)');
        }),
        callGasAsync_('getStaffNameList').then(function (list) {
          staffList = list || [];
          populateSelectOptions_('edit-担当者', [''].concat(staffList), '(未設定)');
        }),
        callGasAsync_('getStatusList').then(function (list) {
          statusList = list || [];
          populateSelectOptions_('edit-状況', [''].concat(statusList), '(未選択)');
        }),
        callGasAsync_('getResultList').then(function (list) {
          resultList = list || [];
          populateSelectOptions_('edit-結果', [''].concat(resultList), '(未選択)');
        }),
        callGasAsync_('getCourseList').then(function (list) {
          courseList = list || [];
          populateSelectOptions_('edit-コース', [''].concat(courseList), '(未選択)');
        }),
        callGasAsync_('getMarkOptions').then(function (list) {
          markOptions = list || [];
          populateMarkOptions_();
        }),
        callGasAsync_('getAreaList').then(function (list) {
          areaList = list || [];
          // プライマリ（エリア1）が一覧に存在すればそれを初期選択、無ければ全エリア
          const primary = CURRENT_USER_AREAS[0];
          currentAreaFilter = (primary && areaList.indexOf(primary) !== -1) ? primary : '';
          renderAreaTabs_();
        }),
        callGasAsync_('getSchoolAreaMap').then(function (map) {
          schoolAreaMap = map || {};
        })
      ]).then(function () {
        loadRecords();
        refreshSpamHoldCounts_(); // 初回表示には含めず、一覧表示とは別に取得する（失敗してもボードの表示は止めない）
      }).catch(function (err) {
        console.error('[KcbBoard] 初期マスタ読み込み失敗:', err && err.code, err && err.message);
        showGlobalError_(window.KCB_MESSAGES.textFor(err && err.code));
      });
    }

    function showModal_(id) {
      document.getElementById(id).style.display = 'flex';
    }
    function hideModal_(id) {
      document.getElementById(id).style.display = 'none';
    }
    function isModalOpen_(id) {
      return document.getElementById(id).style.display === 'flex';
    }

    // モーダルの開閉ボタンをaddEventListenerで確実に紐付け、
    // 背景クリック・Escapeキーでも閉じられるようにする
    function setupModalHandlers_() {
      document.getElementById('editModalSaveBtn').addEventListener('click', saveEditModal);
      document.getElementById('editModalCancelBtn').addEventListener('click', closeEditModal);
      document.getElementById('editModalCloseXBtn').addEventListener('click', closeEditModal);

      document.getElementById('editModalOverlay').addEventListener('click', function (ev) {
        if (ev.target === this) closeEditModal();
      });

      document.getElementById('registerParseBtn').addEventListener('click', parseRegisterForm_);
      document.getElementById('registerSaveBtn').addEventListener('click', saveRegisterModal);
      document.getElementById('registerCancelBtn').addEventListener('click', closeRegisterModal);
      document.getElementById('registerCancelOnlyBtn').addEventListener('click', closeRegisterModal);

      document.getElementById('registerModalOverlay').addEventListener('click', function (ev) {
        if (ev.target === this) closeRegisterModal();
      });

      document.getElementById('chartModalCloseBtn').addEventListener('click', closeKpiChartModal_);
      document.getElementById('chartModalOverlay').addEventListener('click', function (ev) {
        if (ev.target === this) closeKpiChartModal_();
      });

      document.getElementById('spamHoldModalCloseXBtn').addEventListener('click', closeSpamHoldPanel_);
      document.getElementById('spamHoldModalCloseBtn').addEventListener('click', closeSpamHoldPanel_);
      document.getElementById('spamHoldModalOverlay').addEventListener('click', function (ev) {
        if (ev.target === this) closeSpamHoldPanel_();
      });

      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        if (isModalOpen_('registerModalOverlay')) closeRegisterModal();
        else if (isModalOpen_('editModalOverlay')) closeEditModal();
        else if (isModalOpen_('chartModalOverlay')) closeKpiChartModal_();
        else if (isModalOpen_('spamHoldModalOverlay')) closeSpamHoldPanel_();
      });
    }


    // エリアタブを描画する。担当している複数エリア（プライマリ優先）を左側にまとめ、
    // 続けて非担当エリア、最後に「全エリア」を並べる。ログイン担当者のプライマリエリアが初期選択される
    function renderAreaTabs_() {
      const box = document.getElementById('areaTabs');
      box.innerHTML = '';

      const assigned = CURRENT_USER_AREAS.filter(function (a) { return areaList.indexOf(a) !== -1; });
      const unassigned = areaList.filter(function (a) { return assigned.indexOf(a) === -1; });
      const ordered = assigned.concat(unassigned).concat(['']); // 全エリアタブは最後

      ordered.forEach(function (area) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'areaTab' + (area === currentAreaFilter ? ' active' : '');
        btn.textContent = area === '' ? '全エリア' : area;

        const badgeCount = spamHoldCountForArea_(area);
        if (badgeCount > 0) {
          const badge = document.createElement('span');
          badge.className = 'areaTabBadge';
          badge.textContent = badgeCount;
          btn.appendChild(badge);
        }

        btn.onclick = function () {
          currentAreaFilter = area;
          renderAreaTabs_();
          loadRecords();
        };
        box.appendChild(btn);
      });

      updateSpamHoldBanner_();
    }

    function populateMarkOptions_() {
      const box = document.getElementById('editMarkOptions');
      box.innerHTML = '';
      markOptions.forEach(function (m) {
        const label = document.createElement('label');
        label.className = 'markOption';
        label.innerHTML = '<input type="checkbox" value="' + escapeAttr_(m.emoji) + '"> ' +
          escapeHtml_(m.emoji) + ' ' + escapeHtml_(m.label);
        box.appendChild(label);
      });
    }

    function switchTab(tab) {
      ['list', 'dashboard', 'master'].forEach(function (t) {
        document.getElementById('tabBtn-' + t).classList.toggle('active', t === tab);
        document.getElementById('tabPanel-' + t).classList.toggle('active', t === tab);
      });
      if (tab === 'dashboard' && !dashboardLoaded) loadDashboard();
      if (tab === 'dashboard') refreshSpamHoldCounts_();
      if (tab === 'master' && !masterTabLoaded) initMasterTab_();
    }

    function populateSchoolFilter(schools) {
      const sel = document.getElementById('schoolFilter');
      schools.forEach(function (s) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
      });
    }

    function populateSelectOptions_(elementId, options, emptyLabel) {
      const sel = document.getElementById(elementId);
      sel.innerHTML = '';
      options.forEach(function (opt) {
        const el = document.createElement('option');
        el.value = opt;
        el.textContent = opt === '' ? emptyLabel : opt;
        sel.appendChild(el);
      });
    }

    function buildTimeOptions_() {
      const opts = [''];
      for (let h = 9; h <= 21; h++) {
        for (let m = 0; m < 60; m += 15) {
          if (h === 21 && m > 0) break;
          opts.push(('0' + h).slice(-2) + ':' + ('0' + m).slice(-2));
        }
      }
      return opts;
    }

    // 新規登録モーダルの「時」プルダウン用（9時〜21時、営業時間帯に合わせる）
    function buildHourOptions_() {
      const opts = [''];
      for (let h = 9; h <= 21; h++) {
        opts.push(('0' + h).slice(-2));
      }
      return opts;
    }

    let sortOrder = 'desc'; // 受付日時の並び順。デフォルトは降順（新しい受付が一番上）
    let onlySelectedFilter = null; // 「選択した行のみ表示」中のNoの配列。nullの時は全件表示

    // 戻り値のPromiseは、呼び出し元で「処理中」表示をまとめたい場合にのみ利用する
    // （単純な再描画目的の呼び出しは、従来通り戻り値を無視してfire-and-forgetで構わない）
    function loadRecords() {
      const school = document.getElementById('schoolFilter').value;
      rawTextCache = {}; // 表示内容が変わるたびにキャッシュを作り直す
      return callGasAsync_('getRecords', [school || null]).then(function (records) {
        const filtered = applySortOrder_(applyOnlySelectedFilter_(applyDateFilter_(applyAreaFilter_(records))));
        renderTable(filtered);
        prefetchRawTexts_(filtered);
        updateResultCount_(filtered.length);
      }).catch(function (e) {
        if (isAuthRequiredError_(e)) return;
        console.error('getRecords failed:', e);
        alert('一覧の取得でエラーが発生しました: ' + gasErrorText_(e));
      });
    }

    function updateResultCount_(count) {
      const el = document.getElementById('resultCount');
      if (el) el.textContent = count + '件表示中';
    }

    // エリアタブでの絞り込みは、教室フィルタと独立した追加の絞り込みとしてクライアント側で適用する
    // （教室エリア対応表はサーバー側から取得済みなので、通信なしで即座に絞り込める）
    function applyAreaFilter_(records) {
      if (!currentAreaFilter || !records) return records;
      return records.filter(function (r) {
        return schoolAreaMap[r['教室名']] === currentAreaFilter;
      });
    }

    // 体験会日での絞り込み（教室フィルタ・エリアタブとAND条件）。
    // 開始日・終了日はどちらか片方だけの指定も許容し（片側だけ範囲を区切る）、
    // 両方とも空なら絞り込みなし＝全件を通す。
    function applyDateFilter_(records) {
      if (!records) return records;
      const startStr = document.getElementById('dateFilterStart').value;
      const endStr = document.getElementById('dateFilterEnd').value;
      if (!startStr && !endStr) return records;

      const includeUnset = document.getElementById('dateFilterIncludeUnset').checked;
      return records.filter(function (r) {
        const dateStr = toDateInputValue_(r['体験会日']);
        if (!dateStr) return includeUnset;
        if (startStr && dateStr < startStr) return false;
        if (endStr && dateStr > endStr) return false;
        return true;
      });
    }

    // 日付入力欄を手動で変更した場合は、ショートカットボタンのハイライトを解除してから再読込する
    function onDateFilterChange_() {
      clearDateShortcutActive_();
      loadRecords();
    }

    // 「今日」「今週」「来週」ショートカット。週は月曜始まり・日曜終わりで統一する
    function setDateFilterShortcut_(kind) {
      const fmt = function (d) {
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
      };
      const today = new Date();
      let start, end;

      if (kind === 'today') {
        start = new Date(today);
        end = new Date(today);
      } else {
        const day = today.getDay(); // 0=日, 1=月, ... 6=土
        const diffToMonday = (day === 0 ? -6 : 1 - day);
        const monday = new Date(today);
        monday.setDate(today.getDate() + diffToMonday);
        if (kind === 'nextWeek') monday.setDate(monday.getDate() + 7);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        start = monday;
        end = sunday;
      }

      document.getElementById('dateFilterStart').value = fmt(start);
      document.getElementById('dateFilterEnd').value = fmt(end);
      highlightDateShortcut_(kind);
      loadRecords();
    }

    function highlightDateShortcut_(kind) {
      document.querySelectorAll('.dateShortcutBtn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.shortcut === kind);
      });
    }

    function clearDateShortcutActive_() {
      document.querySelectorAll('.dateShortcutBtn').forEach(function (btn) { btn.classList.remove('active'); });
    }

    function clearDateFilter_() {
      document.getElementById('dateFilterStart').value = '';
      document.getElementById('dateFilterEnd').value = '';
      document.getElementById('dateFilterIncludeUnset').checked = false;
      clearDateShortcutActive_();
      loadRecords();
    }

    // 受付一覧タブの操作ボタン群（再読み込み・選択した行のみ表示・ごみ箱へ移動・ごみ箱を見る）は
    // 「操作の範囲」としてまとめて押せなくする（案B）
    function listOpsScopeButtons_() {
      return [
        document.getElementById('reloadListBtn'),
        document.getElementById('onlySelectedBtn'),
        document.getElementById('moveToTrashBtn'),
        document.getElementById('trashViewBtn')
      ];
    }

    // 「選択した行のみ表示」ボタンのオン・オフを切り替える
    function toggleOnlySelected_() {
      if (onlySelectedFilter) {
        onlySelectedFilter = null;
      } else {
        const checked = Array.from(document.querySelectorAll('.rowCheck:checked')).map(function (cb) { return cb.dataset.no; });
        if (checked.length === 0) { alert('表示する行を選択してください'); return; }
        onlySelectedFilter = checked;
      }
      updateOnlySelectedButton_(); // ボタンの文言(最終状態)を先に確定させてから、その文言を基準に処理中表示へ切り替える
      const btn = document.getElementById('onlySelectedBtn');
      withBusy_('listOps', listOpsScopeButtons_(), btn, '読み込み中…', function () {
        return loadRecords();
      });
    }

    function updateOnlySelectedButton_() {
      const btn = document.getElementById('onlySelectedBtn');
      const narrow = window.innerWidth <= 700; // スマホ幅では3ボタンが横並びに収まりやすいよう文言を短縮
      if (onlySelectedFilter) {
        btn.textContent = narrow ? '全件表示' : '全件表示に戻す';
      } else {
        btn.textContent = narrow ? '選択のみ表示' : '選択した行のみ表示';
      }
      btn.classList.toggle('active', !!onlySelectedFilter);
    }

    function applyOnlySelectedFilter_(records) {
      if (!onlySelectedFilter || !records) return records;
      const set = {};
      onlySelectedFilter.forEach(function (no) { set[no] = true; });
      return records.filter(function (r) { return set[r['No']]; });
    }

    // 受付日時見出しクリックで昇順⇄降順を切り替える
    function toggleSort_() {
      sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
      updateSortArrow_();
      loadRecords();
    }

    function updateSortArrow_() {
      document.getElementById('sortArrow').textContent = sortOrder === 'desc' ? '▼' : '▲';
    }

    function applySortOrder_(records) {
      if (!records) return records;
      const sorted = records.slice();
      sorted.sort(function (a, b) {
        const diff = new Date(a['受付日時']) - new Date(b['受付日時']);
        return sortOrder === 'desc' ? -diff : diff;
      });
      return sorted;
    }

    // 一覧の表示を待たせないよう、表示後にバックグラウンドで元メール本文をまとめて取得しキャッシュする
    function prefetchRawTexts_(records) {
      if (!records || records.length === 0) return;
      const nos = records.map(function (r) { return r['No']; });
      window.KcbGas.scriptRun
        .withSuccessHandler(function (map) {
          Object.keys(map || {}).forEach(function (no) { rawTextCache[no] = map[no]; });
        })
        .withFailureHandler(function (e) { console.error('getRawTextsBulk failed:', e); })
        .getRawTextsBulk(nos);
    }

    function statusClass_(status) {
      const known = ['新規受付', '日程決定済み', '対応中', '連絡付かず', 'キャンセル'];
      return known.indexOf(status) !== -1 ? 'status-' + status : 'status-default';
    }

    function typeBadge_(kubun) {
      if (!kubun) return '<span class="badge badge-check">要確認</span>';
      const cls = kubun === 'Kicks' ? 'badge-kicks' : (kubun === 'crefus' ? 'badge-crefus' : 'badge-check');
      return '<span class="badge ' + cls + '">' + escapeHtml_(kubun) + '</span>';
    }

    function renderTable(records) {
      const tbody = document.querySelector('#recordsTable tbody');
      tbody.innerHTML = '';
      if (!records) {
        console.error('getRecordsがnull/undefinedを返しました。サーバー側でエラーが発生している可能性があります。');
        return;
      }

      recordCache = {};
      records.forEach(function (r) {
        const no = r['No'];
        recordCache[no] = r;

        const tr = document.createElement('tr');
        // 連絡済みチェックが入っていない行＝新着（未対応）は濃い黄色で全体マーキングする
        if (!r['連絡済みチェック']) tr.classList.add('newInquiry');
        tr.innerHTML =
          '<td class="col-check sticky sticky-check" data-action="stopPropagation"><label class="rowCheckTapArea"><input type="checkbox" class="rowCheck" data-no="' + escapeAttr_(no) + '"></label></td>' +
          '<td class="col-date sticky sticky-date">' + formatDate(r['受付日時']) + '</td>' +
          '<td class="col-school sticky sticky-school">' + escapeHtml_(r['教室名'] || '') + '</td>' +
          '<td class="col-type sticky sticky-type">' + typeBadge_(r['KicksCrefus']) + '</td>' +
          '<td class="col-name sticky sticky-name" data-no="' + escapeAttr_(no) + '">' + buildWrapCellHtml_(r['生徒名']) + '</td>' +
          '<td class="col-mark marks">' + escapeHtml_(r['マーク'] || '') + '</td>' +
          '<td class="col-kana">' + buildWrapCellHtml_(r['ふりがな']) + '</td>' +
          '<td class="col-grade">' + escapeHtml_(r['新学年'] || '') + '</td>' +
          '<td class="col-tel" data-no="' + escapeAttr_(no) + '">' + escapeHtml_(r['電話番号'] || '') + '</td>' +
          '<td class="col-media">' + escapeHtml_(r['媒体'] || '') + '</td>' +
          '<td class="col-status">' + (r['状況'] ? '<span class="status ' + statusClass_(r['状況']) + '">' + escapeHtml_(r['状況']) + '</span>' : '') + '</td>' +
          '<td class="col-contact" data-action="stopPropagation"><input type="checkbox" class="contactCheck" data-no="' + escapeAttr_(no) + '"' +
            (r['連絡済みチェック'] ? ' checked' : '') + ' data-change-action="updateContactCheck"></td>' +
          '<td class="col-date">' + escapeHtml_(toDateInputValue_(r['体験会日'])) + '</td>' +
          '<td class="col-time">' + escapeHtml_(r['時間'] || '') + '</td>' +
          '<td class="col-staff">' + escapeHtml_(r['担当者'] || '') + '</td>' +
          '<td class="col-staff">' + escapeHtml_(r['サブ担当'] || '') + '</td>' +
          '<td class="col-done">' + escapeHtml_(r['体験会実施状況'] || '') + '</td>' +
          '<td class="col-result">' + escapeHtml_(r['結果'] || '') + '</td>' +
          '<td class="col-course">' + escapeHtml_(r['コース'] || '') + '</td>' +
          '<td class="col-note" data-no="' + escapeAttr_(no) + '"><div class="noteClamp">' + escapeHtml_(r['備考'] || '') + '</div></td>' +
          '<td class="col-body" data-no="' + escapeAttr_(no) + '" data-action="stopPropagation"><button class="iconBtn" title="カーソルを合わせると元メール本文を表示">📄</button></td>';
        tr.onclick = (function (n) { return function () { openEditModal(n); }; })(no);
        tbody.appendChild(tr);
      });

      // 「選択した行のみ表示」中は、絞り込み前に選択していた行のチェックを再現する
      if (onlySelectedFilter) {
        const set = {};
        onlySelectedFilter.forEach(function (no) { set[no] = true; });
        document.querySelectorAll('.rowCheck').forEach(function (cb) {
          if (set[cb.dataset.no]) cb.checked = true;
        });
      }
    }

    function updateContactCheck(el) {
      if (el.disabled) return; // 保存中の行は再クリックを受け付けない（二重実行防止）
      const no = el.dataset.no;
      const checked = el.checked;
      const tr = el.closest('tr');

      el.disabled = true; // 同じ行のみ操作不可にする（他の行は引き続き操作できる）
      const badge = showContactCheckBusy_(el);

      callGasAsync_('updateRecord', [no, '連絡済みチェック', checked]).then(function () {
        if (recordCache[no]) recordCache[no]['連絡済みチェック'] = checked;
        // 連絡済みになった時点で新着マーキング（濃い黄色）を即座に解除する。
        // チェックを外した場合は逆に新着扱いへ戻す
        if (tr) tr.classList.toggle('newInquiry', !checked);
      }).catch(function (e) {
        el.checked = !checked; // 失敗時は元に戻す
        if (isAuthRequiredError_(e)) return; // ログイン画面側で既に案内済みのため重ねて出さない
        showGlobalError_(gasErrorText_(e));
      }).finally(function () {
        el.disabled = false;
        hideContactCheckBusy_(badge);
      });
    }

    // ==== 新規登録モーダル ====
    function setRegisterMode_(mode) {
      const isAuto = mode === 'auto';
      document.getElementById('modeAutoBtn').classList.toggle('active', isAuto);
      document.getElementById('modeManualBtn').classList.toggle('active', !isAuto);
      document.getElementById('registerAutoSection').style.display = isAuto ? 'block' : 'none';
      document.getElementById('registerManualHint').style.display = isAuto ? 'none' : 'block';

      // 自動入力タブを選んだ直後は「解析」するまで入力項目セクションを隠す。
      // 手動タブでは、その場で（空欄のまま）入力項目セクションを表示する。
      showRegisterFieldsSection_(!isAuto);
    }

    function showRegisterFieldsSection_(show) {
      document.getElementById('registerFieldsSection').style.display = show ? 'block' : 'none';
      document.getElementById('registerCancelOnlyRow').style.display = show ? 'none' : 'block';
    }

    function nowLocalDatetimeValue_() {
      const d = new Date();
      const pad = function (n) { return ('0' + n).slice(-2); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function openRegisterModal() {
      // 前回開いた時の内容が残らないよう毎回まっさらな状態にする
      document.getElementById('register-pasteBox').value = '';
      ['教室名', 'KicksCrefus', '生徒名', 'ふりがな', '新学年', '電話番号', 'メールアドレス',
        '媒体', '体験会日', '希望日程参考', '備考'].forEach(function (field) {
        const el = document.getElementById('register-' + field);
        if (el) el.value = '';
      });
      document.getElementById('register-時間時').value = '';
      document.getElementById('register-時間分').value = '';
      // 受付日時は、モーダルを開いた時点の現在日時を初期値にする（手動で変更可能）
      document.getElementById('register-受付日').value = nowLocalDatetimeValue_();
      setRegisterMode_('auto');
      showModal_('registerModalOverlay');
    }

    function closeRegisterModal() {
      hideModal_('registerModalOverlay');
    }

    // 「解析」ボタン：貼り付けたメール本文をparseInquiryText()に通し、結果を各フィールドに
    // 自動入力する（この時点ではまだ受付データへの保存はしない。登録前に内容を確認・修正できる）
    function registerModalScopeButtons_() {
      return [document.getElementById('registerParseBtn'), document.getElementById('registerSaveBtn')];
    }

    function parseRegisterForm_() {
      const text = document.getElementById('register-pasteBox').value;
      if (!text.trim()) { alert('メール本文を貼り付けてください'); return; }

      withBusy_('registerModal', registerModalScopeButtons_(), document.getElementById('registerParseBtn'), '処理中…', function () {
        return callGasAsync_('parseInquiryText', [text]).then(function (parsed) {
          document.getElementById('register-教室名').value = parsed['school'] || '';
          document.getElementById('register-KicksCrefus').value = parsed['kicksCrefus'] || '';
          document.getElementById('register-生徒名').value = parsed['studentName'] || '';
          document.getElementById('register-ふりがな').value = parsed['kana'] || '';
          document.getElementById('register-新学年').value = parsed['grade'] || '';
          document.getElementById('register-電話番号').value = parsed['tel'] || '';
          document.getElementById('register-メールアドレス').value = parsed['mail'] || '';
          document.getElementById('register-媒体').value = parsed['media'] || '';
          document.getElementById('register-体験会日').value = parsed['hopeDate'] || '';
          document.getElementById('register-希望日程参考').value = parsed['hopeSchedule'] || '';
          document.getElementById('register-備考').value = parsed['note'] || '';

          const timeParts = (parsed['hopeTime'] || '').split(':');
          document.getElementById('register-時間時').value = timeParts[0] || '';
          document.getElementById('register-時間分').value = timeParts[1] || '';

          // 解析結果が入った状態で、ここで初めて入力項目セクションを表示する
          showRegisterFieldsSection_(true);
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('解析でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    function saveRegisterModal() {
      const hour = document.getElementById('register-時間時').value;
      const minute = document.getElementById('register-時間分').value;

      const record = {
        school: document.getElementById('register-教室名').value,
        kicksCrefus: document.getElementById('register-KicksCrefus').value,
        studentName: document.getElementById('register-生徒名').value,
        kana: document.getElementById('register-ふりがな').value,
        grade: document.getElementById('register-新学年').value,
        tel: document.getElementById('register-電話番号').value,
        mail: document.getElementById('register-メールアドレス').value,
        media: document.getElementById('register-媒体').value,
        experienceDate: document.getElementById('register-体験会日').value,
        experienceTime: (hour && minute) ? (hour + ':' + minute) : '',
        hopeSchedule: document.getElementById('register-希望日程参考').value,
        note: document.getElementById('register-備考').value,
        rawText: document.getElementById('register-pasteBox').value
      };
      const receivedAtStr = document.getElementById('register-受付日').value;

      if (!record.studentName) {
        if (!confirm('生徒名が未入力です。このまま登録しますか？')) return;
      }

      withBusy_('registerModal', registerModalScopeButtons_(), document.getElementById('registerSaveBtn'), '保存中…', function () {
        return callGasAsync_('registerRecord', [record, receivedAtStr || null]).then(function () {
          closeRegisterModal();
          loadRecords();
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('登録でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    // ==== レコード編集モーダル ====
    function openEditModal(no) {
      const r = recordCache[no];
      if (!r) return;

      document.getElementById('editModalOverlay').dataset.no = no;
      document.getElementById('edit-KicksCrefus').value = r['KicksCrefus'] || '';
      document.getElementById('edit-生徒名').value = r['生徒名'] || '';
      document.getElementById('edit-ふりがな').value = r['ふりがな'] || '';
      document.getElementById('edit-新学年').value = r['新学年'] || '';
      document.getElementById('edit-電話番号').value = r['電話番号'] || '';
      document.getElementById('edit-媒体').value = r['媒体'] || '';
      document.getElementById('edit-状況').value = r['状況'] || '';
      document.getElementById('edit-体験会日').value = toDateInputValue_(r['体験会日']);
      document.getElementById('edit-時間').value = r['時間'] || '';
      document.getElementById('edit-担当者').value = r['担当者'] || '';
      document.getElementById('edit-サブ担当').value = r['サブ担当'] || '';
      document.getElementById('edit-体験会実施状況').value = r['体験会実施状況'] || '';
      document.getElementById('edit-結果').value = r['結果'] || '';
      document.getElementById('edit-コース').value = r['コース'] || '';
      document.getElementById('edit-連絡済みチェック').checked = !!r['連絡済みチェック'];
      document.getElementById('edit-備考').value = r['備考'] || '';
      document.getElementById('edit-メモ').value = r['メモ'] || '';

      const marks = r['マーク'] || '';
      document.querySelectorAll('#editMarkOptions input[type=checkbox]').forEach(function (cb) {
        cb.checked = marks.indexOf(cb.value) !== -1;
      });

      showModal_('editModalOverlay');
    }

    function closeEditModal() {
      hideModal_('editModalOverlay');
    }

    function saveEditModal() {
      const no = document.getElementById('editModalOverlay').dataset.no;
      const selectedMarks = Array.from(document.querySelectorAll('#editMarkOptions input[type=checkbox]:checked'))
        .map(function (cb) { return cb.value; })
        .join('');

      const fields = {
        'KicksCrefus': document.getElementById('edit-KicksCrefus').value,
        '生徒名': document.getElementById('edit-生徒名').value,
        'ふりがな': document.getElementById('edit-ふりがな').value,
        '新学年': document.getElementById('edit-新学年').value,
        '電話番号': document.getElementById('edit-電話番号').value,
        '媒体': document.getElementById('edit-媒体').value,
        '状況': document.getElementById('edit-状況').value,
        '体験会日': document.getElementById('edit-体験会日').value,
        '時間': document.getElementById('edit-時間').value,
        '担当者': document.getElementById('edit-担当者').value,
        'サブ担当': document.getElementById('edit-サブ担当').value,
        '体験会実施状況': document.getElementById('edit-体験会実施状況').value,
        '結果': document.getElementById('edit-結果').value,
        'コース': document.getElementById('edit-コース').value,
        '連絡済みチェック': document.getElementById('edit-連絡済みチェック').checked,
        '備考': document.getElementById('edit-備考').value,
        'メモ': document.getElementById('edit-メモ').value,
        'マーク': selectedMarks
      };

      withBusy_('editModal', [document.getElementById('editModalSaveBtn')], document.getElementById('editModalSaveBtn'), '保存中…', function () {
        return callGasAsync_('updateRecordFields', [no, fields]).then(function () {
          closeEditModal();
          loadRecords();
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('保存でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    // ==== 生徒名・備考・本文セルのホバーポップアップ ====
    // 備考・メモ・マークはrecordCacheに、元メール本文はrawTextCacheに入っているため
    // どれもサーバー通信なしで即時表示できる
    let hoverHideTimer = null;
    let currentHoverTriggerEl = null; // 現在ポップアップを開かせているトリガー要素。同じ要素上にいる間は内容を維持する

    // ポップアップを閉じる予約をキャンセルする（アイコン⇔ポップアップ間の移動中に消えないようにする）
    function cancelHoverHide_() {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
    }

    // 即座に閉じず、少し待ってから閉じる（待っている間に戻ってきたらcancelHoverHide_で取り消される）
    function scheduleHoverHide_() {
      cancelHoverHide_();
      hoverHideTimer = setTimeout(function () {
        hidePopup_();
        hoverHideTimer = null;
      }, 150);
    }

    // タッチ操作主体の端末（スマホ・タブレット）かどうか。trueならホバーの代わりにタップで開閉する
    function isTouchDevice_() {
      return window.matchMedia('(hover: none)').matches;
    }

    function setupHoverPopups_() {
      const table = document.getElementById('recordsTable');
      const popup = document.getElementById('hoverPopup');

      if (isTouchDevice_()) {
        setupHoverPopupsTouch_(table, popup);
        return;
      }

      table.addEventListener('mouseover', function (ev) {
        const nameTd = ev.target.closest('.col-name');
        const noteTd = ev.target.closest('.col-note');
        const bodyTd = ev.target.closest('.col-body');
        const telTd = ev.target.closest('.col-tel');
        const triggerTd = nameTd || noteTd || bodyTd || telTd;
        if (!triggerTd) return;
        cancelHoverHide_();
        if (triggerTd === currentHoverTriggerEl) return; // 同じトリガー上に留まっている間は内容を維持（上書きしない）
        currentHoverTriggerEl = triggerTd; // 別のトリガーに乗った場合は即座に切り替える
        if (nameTd) showNamePopup_(nameTd);
        else if (noteTd) showNotePopup_(noteTd);
        else if (bodyTd) showBodyPopup_(bodyTd);
        else if (telTd) showTelPopup_(telTd);
      });
      table.addEventListener('mouseout', function (ev) {
        if (ev.target.closest('.col-name, .col-note, .col-body, .col-tel')) scheduleHoverHide_();
      });

      // ポップアップ自体にカーソルが乗っている間は閉じない。離れたら同じ遅延で閉じる
      popup.addEventListener('mouseenter', cancelHoverHide_);
      popup.addEventListener('mouseleave', scheduleHoverHide_);
    }

    // スマホ・タブレット向け：タップでポップアップを開閉する。
    // キャプチャフェーズで先取りしてstopPropagationすることで、col-body等の個別stopPropagationや
    // 行タップ（編集モーダルを開く）より先に処理し、対象セル以外のタップでは通常通り行タップを機能させる
    function setupHoverPopupsTouch_(table, popup) {
      table.addEventListener('click', function (ev) {
        const nameTd = ev.target.closest('.col-name');
        const noteTd = ev.target.closest('.col-note');
        const bodyTd = ev.target.closest('.col-body');
        const telTd = ev.target.closest('.col-tel');
        const triggerTd = nameTd || noteTd || bodyTd || telTd;
        if (!triggerTd) return;
        ev.stopPropagation();

        if (triggerTd === currentHoverTriggerEl && popup.style.display === 'block') {
          hidePopup_();
          return;
        }
        currentHoverTriggerEl = triggerTd;
        if (nameTd) showNamePopup_(nameTd);
        else if (noteTd) showNotePopup_(noteTd);
        else if (bodyTd) showBodyPopup_(bodyTd);
        else if (telTd) showTelPopup_(telTd);
      }, true);

      // ポップアップ表示中に対象セル以外の場所をタップしたら閉じる
      document.addEventListener('click', function (ev) {
        if (popup.style.display !== 'block') return;
        if (ev.target.closest('.hoverPopup')) return;
        hidePopup_();
      });
    }

    function markMeaningText_(marks) {
      if (!marks) return '（マークなし）';
      const parts = markOptions.filter(function (m) { return marks.indexOf(m.emoji) !== -1; });
      if (parts.length === 0) return marks;
      return parts.map(function (m) { return m.emoji + ' ' + m.label; }).join(' / ');
    }

    function showNamePopup_(td) {
      const r = recordCache[td.dataset.no];
      if (!r) return;
      const html =
        '<h5>備考</h5><p>' + escapeHtml_(r['備考'] || '（備考なし）') + '</p>' +
        '<h5>メモ</h5><p>' + escapeHtml_(r['メモ'] || '（メモなし）') + '</p>' +
        '<h5>マーク</h5><p>' + escapeHtml_(markMeaningText_(r['マーク'])) + '</p>';
      showPopupAt_(td, html);
    }

    function showNotePopup_(td) {
      const r = recordCache[td.dataset.no];
      if (!r) return;
      const html = '<h5>備考（全文）</h5><p>' + escapeHtml_(r['備考'] || '（備考なし）') + '</p>';
      showPopupAt_(td, html);
    }

    // 元メール本文はエスケープ後のHTML文字列ではなく、textContentでそのまま流し込む
    // （リンクをaタグ化しない。折り返しは.hoverPopup自体のwhite-space:pre-wrapに委ねる）
    function showBodyPopup_(td) {
      const no = td.dataset.no;
      const text = rawTextCache.hasOwnProperty(no) ? (rawTextCache[no] || '（元メール本文がありません）') : '読み込み中…';
      const frag = document.createDocumentFragment();
      const h5 = document.createElement('h5');
      h5.textContent = '元メール本文';
      const p = document.createElement('p');
      p.textContent = text;
      frag.appendChild(h5);
      frag.appendChild(p);
      showPopupAt_(td, frag);
    }

    // 電話番号は見間違い防止のため通常の2倍のフォントサイズで表示する
    function showTelPopup_(td) {
      const r = recordCache[td.dataset.no];
      if (!r) return;
      const html = '<h5>電話番号</h5><p class="telPopupText">' + escapeHtml_(r['電話番号'] || '（電話番号なし）') + '</p>';
      showPopupAt_(td, html);
    }

    // contentは既存呼び出し元（escapeHtml_済みのHTML文字列）か、showBodyPopup_が渡すDocumentFragmentのいずれか
    function showPopupAt_(td, content) {
      const popup = document.getElementById('hoverPopup');
      popup.innerHTML = '';
      if (typeof content === 'string') {
        popup.innerHTML = content;
      } else {
        popup.appendChild(content);
      }
      popup.style.display = 'block'; // サイズ計算のため先に表示してからoffsetWidth/Heightを参照する

      const rect = td.getBoundingClientRect();
      const popupWidth = popup.offsetWidth;
      const popupHeight = popup.offsetHeight;
      const margin = -2; // トリガー要素とわずかに重なる位置に表示する（遅延クローズ150msで隙間通過中の誤消滅を防止）

      let left = rect.left;
      if (left + popupWidth > window.innerWidth - 8) {
        left = rect.right - popupWidth;
      }
      left = Math.max(8, left);

      // 下に十分なスペースが無ければ、セルの上側に表示を切り替える
      const spaceBelow = window.innerHeight - rect.bottom;
      let top = spaceBelow >= popupHeight + margin
        ? rect.bottom + margin
        : rect.top - popupHeight - margin;
      top = Math.max(8, top);

      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }

    function hidePopup_() {
      document.getElementById('hoverPopup').style.display = 'none';
      currentHoverTriggerEl = null; // 閉じたら次に同じ要素へ乗った時も再表示できるようにリセット
    }

    // ==== ごみ箱への移動（ソフトデリート） ====
    function moveSelectedToTrash() {
      const checked = Array.from(document.querySelectorAll('.rowCheck:checked')).map(function (cb) {
        return cb.dataset.no;
      });
      if (checked.length === 0) { alert('ごみ箱へ移動する行を選択してください'); return; }

      if (checked.length >= 5) {
        if (!confirm(checked.length + '件をごみ箱へ移動します。よろしいですか？')) return;
      }

      const btn = document.getElementById('moveToTrashBtn');
      withBusy_('listOps', listOpsScopeButtons_(), btn, '処理中…', function () {
        return callGasAsync_('deleteRecords', [checked]).then(function (res) {
          alert(res.deletedCount + '件をごみ箱へ移動しました');
          loadRecords();
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('ごみ箱への移動でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    // ==== 集計ダッシュボード ====
    let dashboardEnrollmentRows = []; // 在籍・継続状況の現在表示中の値（保存時にここから読み取る）

    function loadDashboard() {
      window.KcbGas.scriptRun
        .withSuccessHandler(function (data) {
          dashboardLoaded = true;
          renderDashboard(data);
        })
        .withFailureHandler(function (e) {
          console.error('getDashboardData failed:', e);
          alert('集計データの取得でエラーが発生しました: ' + gasErrorText_(e));
        })
        .getDashboardData();
    }

    function renderDashboard(data) {
      lastDashboardData = data;
      if (isModalOpen_('chartModalOverlay') && currentKpiChartType_) renderKpiChart_();

      document.getElementById('stat-needsReview').textContent = data.needsReviewCount;
      document.getElementById('stat-uncontacted').textContent = data.uncontactedCount;

      const schoolBody = document.querySelector('#schoolTable tbody');
      schoolBody.innerHTML = '';
      data.schools.forEach(function (s) { schoolBody.appendChild(schoolRow_(s, false)); });
      schoolBody.appendChild(schoolRow_(data.totals, true));

      const resultBody = document.querySelector('#resultTable tbody');
      resultBody.innerHTML = '';
      data.schools.forEach(function (s) { resultBody.appendChild(resultRow_(s, false)); });
      resultBody.appendChild(resultRow_(data.totals, true));

      fillCountTable_('#courseTable tbody', data.courseBreakdown);
      fillCountTable_('#mediaTable tbody', data.mediaBreakdown);
      renderGradeGrid_(data.gradeBreakdown);

      renderEnrollmentTable_(data.enrollment);
    }

    // ①問合せ総数・②受付数(ｷｬﾝｾﾙ除く)・③実施状況
    function schoolRow_(s, isTotal) {
      const tr = document.createElement('tr');
      if (isTotal) tr.className = 'totalRow';
      tr.innerHTML =
        '<td>' + escapeHtml_(s.name) + '</td>' +
        '<td>' + s.total + '</td>' +
        '<td>' + s.Kicks.received + '</td>' +
        '<td>' + s.crefus.received + '</td>' +
        '<td>' + s.remaining + '</td>' +
        '<td>' + s.conductedTotal + '</td>' +
        '<td>' + (s.remaining + s.conductedTotal) + '</td>';
      return tr;
    }

    // ④体験会結果集計（Kicks／crefus別）
    function resultRow_(s, isTotal) {
      const tr = document.createElement('tr');
      if (isTotal) tr.className = 'totalRow';
      tr.innerHTML = '<td>' + escapeHtml_(s.name) + '</td>' + kcResultCells_(s.Kicks) + kcResultCells_(s.crefus);
      return tr;
    }

    function kcResultCells_(kc) {
      return '<td>' + kc.conducted + '</td>' +
        '<td>' + kc.ok + '</td>' +
        '<td>' + kc.hold + '</td>' +
        '<td>' + kc.ng + '</td>' +
        '<td>' + (kc.conducted > 0 ? Math.round(kc.rate * 1000) / 10 + '%' : '-') + '</td>';
    }

    function fillCountTable_(selector, list) {
      const tbody = document.querySelector(selector);
      tbody.innerHTML = '';
      if (!list || list.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="2">データがありません</td>';
        tbody.appendChild(tr);
        return;
      }
      list.forEach(function (item) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml_(item.name) + '</td><td>' + item.count + '</td>';
        tbody.appendChild(tr);
      });
    }

    // ⑥学年別内訳：0名の学年も含めて全学年を常にタイル表示する
    function renderGradeGrid_(list) {
      const grid = document.getElementById('gradeGrid');
      grid.innerHTML = '';
      (list || []).forEach(function (item) {
        const tile = document.createElement('div');
        tile.className = 'gradeTile' + (item.count === 0 ? ' isZero' : '');
        tile.innerHTML =
          '<div class="gradeName">' + escapeHtml_(item.name) + '</div>' +
          '<div class="gradeCount">' + item.count + '</div>';
        grid.appendChild(tile);
      });
    }

    // ==== KPIグラフ（📊アイコンからモーダルで表示。データは直近のダッシュボード取得結果を再利用） ====
    const KPI_CHART_TITLES_ = {
      weeklyTrend: '週別受付数の推移',
      kcTrend: 'Kicks/crefus比率の推移（週別）',
      rateCompare: '実施率／入会率比較',
      mediaPie: '媒体別の流入内訳'
    };
    const KPI_PALETTE_ = ['#C97A1E', '#8A4F0E', '#D8A466', '#7A6B4A', '#B8860B', '#E3A659', '#A6996F', '#9A6C1B'];

    function openKpiChart_(type) {
      if (!lastDashboardData) { alert('先にダッシュボードを更新してください'); return; }
      currentKpiChartType_ = type;
      if (type === 'rateCompare') rateCompareScope_ = 'school';

      document.getElementById('chartModalTitle').textContent = '📊 ' + KPI_CHART_TITLES_[type];
      document.getElementById('chartModalToggle').style.display = (type === 'rateCompare') ? 'flex' : 'none';
      updateRateScopeButtons_();
      showModal_('chartModalOverlay');
      renderKpiChart_();
    }

    function closeKpiChartModal_() {
      hideModal_('chartModalOverlay');
      if (dashboardChartInstance) { dashboardChartInstance.destroy(); dashboardChartInstance = null; }
      currentKpiChartType_ = null;
    }

    function setRateCompareScope_(scope) {
      rateCompareScope_ = scope;
      updateRateScopeButtons_();
      renderKpiChart_();
    }

    function updateRateScopeButtons_() {
      document.getElementById('rateScopeSchoolBtn').classList.toggle('active', rateCompareScope_ === 'school');
      document.getElementById('rateScopeAreaBtn').classList.toggle('active', rateCompareScope_ === 'area');
    }

    function renderKpiChart_() {
      if (!currentKpiChartType_ || !lastDashboardData) return;
      if (dashboardChartInstance) { dashboardChartInstance.destroy(); dashboardChartInstance = null; }
      const ctx = document.getElementById('chartModalCanvas').getContext('2d');
      dashboardChartInstance = new Chart(ctx, buildKpiChartConfig_(currentKpiChartType_, lastDashboardData));
    }

    function buildKpiChartConfig_(type, data) {
      const gridColor = '#EFE7D3';
      const textColor = '#7A6B4A';
      const isNarrow = window.innerWidth <= 700;
      const axisTicks = { color: textColor, font: { size: isNarrow ? 10 : 11 } };

      if (type === 'weeklyTrend') {
        const t = data.kpiCharts.weeklyTrend;
        return {
          type: 'line',
          data: {
            labels: t.labels,
            datasets: [{
              label: '受付数',
              data: t.counts,
              borderColor: '#C97A1E',
              backgroundColor: 'rgba(201,122,30,0.15)',
              fill: true,
              tension: 0.25,
              pointBackgroundColor: '#C97A1E',
              pointRadius: 3
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: axisTicks, grid: { color: gridColor } },
              y: { ticks: Object.assign({ precision: 0 }, axisTicks), grid: { color: gridColor }, beginAtZero: true }
            }
          }
        };
      }

      if (type === 'kcTrend') {
        const t = data.kpiCharts.weeklyKcTrend;
        return {
          type: 'bar',
          data: {
            labels: t.labels,
            datasets: [
              { label: 'Kicks', data: t.kicks, backgroundColor: '#C97A1E' },
              { label: 'crefus', data: t.crefus, backgroundColor: '#7A6B4A' }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: textColor } } },
            scales: {
              x: { ticks: axisTicks, grid: { display: false }, stacked: true },
              y: { ticks: Object.assign({ precision: 0 }, axisTicks), grid: { color: gridColor }, beginAtZero: true, stacked: true }
            }
          }
        };
      }

      if (type === 'rateCompare') {
        const src = rateCompareScope_ === 'area' ? data.kpiCharts.areaRates : data.kpiCharts.schoolRates;
        return {
          type: 'bar',
          data: {
            labels: src.labels,
            datasets: [
              { label: '実施率(%)', data: src.conductedRate, backgroundColor: '#C97A1E' },
              { label: '入会率(%)', data: src.enrollRate, backgroundColor: '#D8A466' }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: textColor } } },
            scales: {
              x: { ticks: Object.assign({}, axisTicks, { font: { size: 10.5 } }), grid: { display: false } },
              y: {
                ticks: Object.assign({}, axisTicks, { callback: function (v) { return v + '%'; } }),
                grid: { color: gridColor }, beginAtZero: true, max: 100
              }
            }
          }
        };
      }

      if (type === 'mediaPie') {
        const m = data.mediaBreakdown || [];
        return {
          type: 'pie',
          data: {
            labels: m.map(function (x) { return x.name; }),
            datasets: [{
              data: m.map(function (x) { return x.count; }),
              backgroundColor: m.map(function (_, i) { return KPI_PALETTE_[i % KPI_PALETTE_.length]; }),
              borderColor: '#FBF9F3',
              borderWidth: 2
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: isNarrow ? 'bottom' : 'right', labels: { color: textColor, boxWidth: 12 } } }
          }
        };
      }
    }

    // ⑤⑥在籍・継続状況（手入力＋自動計算の混在テーブル）
    function renderEnrollmentTable_(enrollment) {
      dashboardEnrollmentRows = enrollment.rows;
      const tbody = document.querySelector('#enrollmentTable tbody');
      tbody.innerHTML = '';
      enrollment.rows.forEach(function (r, i) { tbody.appendChild(enrollmentRow_(r, i, false)); });
      tbody.appendChild(enrollmentRow_(enrollment.total, -1, true));
    }

    function enrollmentPct_(v) {
      return (v === null || v === undefined) ? '-' : Math.round(v * 1000) / 10 + '%';
    }

    function enrollmentRow_(r, i, isTotal) {
      const tr = document.createElement('tr');
      if (isTotal) tr.className = 'totalRow';

      function numCell(field, value) {
        if (isTotal) return '<td>' + value + '</td>';
        return '<td><input type="number" class="enrollInput" data-idx="' + i + '" data-field="' + field + '" value="' + escapeAttr_(value) + '" min="0"></td>';
      }

      tr.innerHTML =
        '<td>' + escapeHtml_(r.school) + '</td>' +
        numCell('kicksBasicEnrolled', r.kicksBasicEnrolled) + numCell('kicksBasicContinuing', r.kicksBasicContinuing) +
        numCell('kicksStandardEnrolled', r.kicksStandardEnrolled) + numCell('kicksStandardContinuing', r.kicksStandardContinuing) +
        numCell('kicksAdvancedEnrolled', r.kicksAdvancedEnrolled) + numCell('kicksAdvancedContinuing', r.kicksAdvancedContinuing) +
        '<td>' + enrollmentPct_(r.kicksContinuationRate) + '</td>' +
        '<td>' + r.kicksNewEnrollment + '</td>' +
        '<td>' + r.kicksTotal + '</td>' +
        numCell('crefusEnrolled', r.crefusEnrolled) + numCell('crefusContinuing', r.crefusContinuing) +
        '<td>' + enrollmentPct_(r.crefusContinuationRate) + '</td>' +
        '<td>' + r.crefusNewEnrollment + '</td>' +
        '<td>' + r.crefusTotal + '</td>' +
        '<td>' + r.grandTotal + '</td>' +
        numCell('targetCount', r.targetCount) +
        '<td>' + r.targetGap + '</td>';
      return tr;
    }

    function saveEnrollmentInputs_() {
      document.querySelectorAll('#enrollmentTable .enrollInput').forEach(function (input) {
        const idx = Number(input.dataset.idx);
        const field = input.dataset.field;
        const row = dashboardEnrollmentRows[idx];
        if (row) row[field] = Number(input.value) || 0;
      });

      const statusEl = document.getElementById('enrollmentSaveStatus');
      statusEl.textContent = '保存中…';

      window.KcbGas.scriptRun
        .withSuccessHandler(function () {
          statusEl.textContent = '保存しました（' + new Date().toLocaleTimeString('ja-JP') + '）';
          loadDashboard(); // 継続率・合計等を再計算して反映
        })
        .withFailureHandler(function (e) {
          console.error('saveEnrollmentInputs failed:', e);
          statusEl.textContent = '';
          alert('保存でエラーが発生しました: ' + gasErrorText_(e));
        })
        .saveEnrollmentInputs(dashboardEnrollmentRows.map(function (r) {
          return {
            school: r.school,
            kicksBasicEnrolled: r.kicksBasicEnrolled,
            kicksBasicContinuing: r.kicksBasicContinuing,
            kicksStandardEnrolled: r.kicksStandardEnrolled,
            kicksStandardContinuing: r.kicksStandardContinuing,
            kicksAdvancedEnrolled: r.kicksAdvancedEnrolled,
            kicksAdvancedContinuing: r.kicksAdvancedContinuing,
            crefusEnrolled: r.crefusEnrolled,
            crefusContinuing: r.crefusContinuing,
            targetCount: r.targetCount
          };
        }));
    }

    // ==== マスタ管理タブ ====
    function initMasterTab_() {
      window.KcbGas.scriptRun
        .withSuccessHandler(function (names) {
          const sel = document.getElementById('masterSelect');
          sel.innerHTML = '';
          names.forEach(function (n) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            sel.appendChild(opt);
          });
          masterTabLoaded = true;
          loadMasterList();
        })
        .withFailureHandler(function (e) { console.error('getMasterListNames failed:', e); })
        .getMasterListNames();
    }

    // 戻り値のPromiseは、呼び出し元で「処理中」表示をまとめたい場合にのみ利用する
    function loadMasterList() {
      const name = document.getElementById('masterSelect').value;
      if (!name) return Promise.resolve();
      return callGasAsync_('getMasterListData', [name]).then(renderMasterTable).catch(function (e) {
        if (isAuthRequiredError_(e)) return;
        alert('マスタの取得でエラーが発生しました: ' + gasErrorText_(e));
      });
    }

    // マスタ管理タブの操作ボタン群（再読み込み・行を追加・保存）は「操作の範囲」としてまとめて押せなくする
    function masterTabScopeButtons_() {
      return [
        document.getElementById('masterReloadBtn'),
        document.getElementById('masterAddBtn'),
        document.getElementById('masterSaveBtn')
      ];
    }

    // ツールバーの「再読み込み」ボタン専用（プルダウン変更時のloadMasterList呼び出しは処理中表示の対象外）
    function reloadMasterList_() {
      const btn = document.getElementById('masterReloadBtn');
      withBusy_('masterTab', masterTabScopeButtons_(), btn, '読み込み中…', function () {
        return loadMasterList();
      });
    }

    // マスタ管理タブの編集操作（追加・保存・並び替えヒント）は管理者のみ表示する。
    // 閲覧（プルダウン選択・再読み込み・一覧表示）は全スタッフが引き続き利用できる
    function setupMasterAdminUi_() {
      if (IS_MASTER_ADMIN) return;
      document.getElementById('masterAddBtn').style.display = 'none';
      document.getElementById('masterSaveBtn').style.display = 'none';
      document.getElementById('masterDragHint').style.display = 'none';
      document.getElementById('masterReadonlyNotice').style.display = 'block';
    }

    // ==== ごみ箱セクション（受付一覧タブ内） ====
    function showTrashView_() {
      document.getElementById('listSection').style.display = 'none';
      document.getElementById('trashSection').style.display = 'block';
      document.getElementById('trashViewBtn').style.display = 'none';
      const btn = document.getElementById('trashViewBtn');
      withBusy_('listOps', listOpsScopeButtons_(), btn, '読み込み中…', function () {
        return loadTrashList_();
      });
    }

    function showListView_() {
      document.getElementById('trashSection').style.display = 'none';
      document.getElementById('listSection').style.display = 'block';
      document.getElementById('trashViewBtn').style.display = '';
    }

    // 戻り値のPromiseは、呼び出し元で「処理中」表示をまとめたい場合にのみ利用する
    function loadTrashList_() {
      return callGasAsync_('getTrashRecords').then(renderTrashTable_).catch(function (e) {
        if (isAuthRequiredError_(e)) return;
        alert('ごみ箱の取得でエラーが発生しました: ' + gasErrorText_(e));
      });
    }

    function renderTrashTable_(rows) {
      const thead = document.querySelector('#trashTable thead');
      const tbody = document.querySelector('#trashTable tbody');

      thead.innerHTML = '<tr><th>削除日時</th><th>削除実行者</th><th>生徒名</th><th>教室名</th><th>受付日時</th><th></th></tr>';
      tbody.innerHTML = '';

      if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">ごみ箱は空です</td></tr>';
        return;
      }

      rows.forEach(function (r) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml_(formatDate(r['削除日時'])) + '</td>' +
          '<td>' + escapeHtml_(r['削除実行者'] || '') + '</td>' +
          '<td>' + escapeHtml_(r['生徒名'] || '') + '</td>' +
          '<td>' + escapeHtml_(r['教室名'] || '') + '</td>' +
          '<td>' + escapeHtml_(formatDate(r['受付日時'])) + '</td>' +
          '<td></td>';

        const actionTd = tr.lastElementChild;
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'kcbBusyMinW-restore';
        restoreBtn.textContent = '復元';
        restoreBtn.onclick = function () { restoreTrashRow_(r['No'], restoreBtn); };
        actionTd.appendChild(restoreBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'kcbBusyMinW-delete';
        deleteBtn.textContent = '完全に削除';
        deleteBtn.onclick = function () { permanentlyDeleteTrashRow_(r['No'], deleteBtn); };
        actionTd.appendChild(deleteBtn);

        tbody.appendChild(tr);
      });
    }

    // ごみ箱の画面（範囲d）：復元・完全削除はテーブル内のどのボタンを押しても、
    // テーブル全体の復元・削除ボタンをまとめて押せなくする
    function trashScopeButtons_() {
      return Array.from(document.querySelectorAll('#trashTable button'));
    }

    function restoreTrashRow_(no, btn) {
      withBusy_('trashSection', trashScopeButtons_(), btn, '処理中…', function () {
        return callGasAsync_('restoreFromTrash', [no]).then(function () {
          alert('復元しました');
          loadTrashList_();
          loadRecords();
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('復元でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    function permanentlyDeleteTrashRow_(no, btn) {
      if (!confirm('完全に削除します。この操作は元に戻せません。よろしいですか？')) return;
      withBusy_('trashSection', trashScopeButtons_(), btn, '処理中…', function () {
        return callGasAsync_('permanentlyDeleteFromTrash', [no]).then(function () {
          alert('完全に削除しました');
          loadTrashList_();
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('削除でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    function renderMasterTable(data) {
      currentMasterColumns = data.columns;
      const thead = document.querySelector('#masterTable thead');
      const tbody = document.querySelector('#masterTable tbody');

      thead.innerHTML = '<tr><th></th>' +
        data.columns.map(function (c) { return '<th>' + escapeHtml_(c.name) + '</th>'; }).join('') +
        '<th></th></tr>';

      tbody.innerHTML = '';
      data.rows.forEach(function (row) { tbody.appendChild(buildMasterRow_(row)); });
    }

    let draggingMasterRow = null;

    function buildMasterRow_(rowValues) {
      const tr = document.createElement('tr');
      tr.draggable = false; // ドラッグハンドルを押している間だけtrueにする（入力欄操作との干渉を防ぐ）

      const dragTd = document.createElement('td');
      dragTd.className = 'dragHandle';
      if (IS_MASTER_ADMIN) {
        tr.addEventListener('dragstart', function () {
          draggingMasterRow = tr;
          tr.classList.add('dragging');
        });
        tr.addEventListener('dragend', function () {
          tr.classList.remove('dragging');
          tr.draggable = false;
          draggingMasterRow = null;
        });
        tr.addEventListener('dragover', function (ev) {
          ev.preventDefault();
          if (!draggingMasterRow || draggingMasterRow === tr) return;
          const tbody = tr.parentNode;
          const after = masterDragAfterElement_(tbody, ev.clientY);
          if (after == null) {
            tbody.appendChild(draggingMasterRow);
          } else {
            tbody.insertBefore(draggingMasterRow, after);
          }
        });
        dragTd.title = 'ドラッグして並び替え';
        dragTd.textContent = '⋮⋮';
        dragTd.addEventListener('mousedown', function () { tr.draggable = true; });
        dragTd.addEventListener('mouseup', function () { tr.draggable = false; });
      } else {
        dragTd.style.opacity = '0.3'; // 編集権限が無いスタッフには並び替え不可であることを視覚的に示す
        dragTd.textContent = '⋮⋮';
      }
      tr.appendChild(dragTd);

      currentMasterColumns.forEach(function (col, i) {
        const td = document.createElement('td');
        const currentVal = rowValues[i] || '';
        const disabledAttr = IS_MASTER_ADMIN ? '' : ' disabled';
        if (col.type === 'checkbox') {
          td.innerHTML = '<input type="checkbox"' + (currentVal ? ' checked' : '') + disabledAttr + '>';
        } else if (col.type === 'select') {
          // 既存値が選択肢に無い場合（他マスタから削除された等）も表示だけはできるよう、先頭に加えておく
          const opts = (col.options || []).slice();
          if (currentVal && opts.indexOf(currentVal) === -1) opts.unshift(currentVal);
          let html = '<select' + disabledAttr + '><option value="">(未選択)</option>';
          opts.forEach(function (opt) {
            html += '<option value="' + escapeAttr_(opt) + '"' + (opt === currentVal ? ' selected' : '') + '>' + escapeHtml_(opt) + '</option>';
          });
          html += '</select>';
          td.innerHTML = html;
        } else {
          td.innerHTML = '<input type="text" value="' + escapeAttr_(currentVal) + '"' + disabledAttr + '>';
        }
        tr.appendChild(td);
      });
      const delTd = document.createElement('td');
      if (IS_MASTER_ADMIN) {
        delTd.innerHTML = '<button data-action="removeRow">削除</button>';
      }
      tr.appendChild(delTd);
      return tr;
    }

    function addMasterRow() {
      if (!currentMasterColumns.length) return;
      const emptyRow = currentMasterColumns.map(function () { return ''; });
      document.querySelector('#masterTable tbody').appendChild(buildMasterRow_(emptyRow));
    }

    // ドラッグ中の行を、マウスのY座標から見てどの行の直前に挿入すべきか判定する
    function masterDragAfterElement_(container, y) {
      const rows = Array.from(container.querySelectorAll('tr:not(.dragging)'));
      return rows.reduce(function (closest, row) {
        const box = row.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset: offset, element: row };
        }
        return closest;
      }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
    }

    function saveMasterList() {
      const name = document.getElementById('masterSelect').value;
      const rows = Array.from(document.querySelectorAll('#masterTable tbody tr')).map(function (tr) {
        const cells = tr.querySelectorAll('td');
        return currentMasterColumns.map(function (col, i) {
          // cells[0]はドラッグハンドル列なので、データ列は1つずれる
          const input = cells[i + 1].querySelector('input, select');
          return col.type === 'checkbox' ? input.checked : input.value;
        });
      });

      const btn = document.getElementById('masterSaveBtn');
      withBusy_('masterTab', masterTabScopeButtons_(), btn, '保存中…', function () {
        return callGasAsync_('saveMasterListData', [name, rows]).then(function (res) {
          alert('保存しました（' + res.rowCount + '件）');
          loadMasterList();
          if (name === 'マークマスタ') {
            window.KcbGas.scriptRun
              .withSuccessHandler(function (list) { markOptions = list || []; populateMarkOptions_(); })
              .withFailureHandler(function (e) {
                console.error('getMarkOptions failed:', e);
                alert('マークの選択肢の再取得に失敗しました。画面を再読み込みしてください: ' + gasErrorText_(e));
              })
              .getMarkOptions();
          }
          if (name === 'エリアマスタ') {
            window.KcbGas.scriptRun
              .withSuccessHandler(function (list) {
                areaList = list || [];
                if (areaList.indexOf(currentAreaFilter) === -1) currentAreaFilter = '';
                renderAreaTabs_();
              })
              .withFailureHandler(function (e) {
                console.error('getAreaList failed:', e);
                alert('エリア一覧の再取得に失敗しました。画面を再読み込みしてください: ' + gasErrorText_(e));
              })
              .getAreaList();
          }
          if (name === '教室エリア対応表') {
            window.KcbGas.scriptRun
              .withSuccessHandler(function (map) { schoolAreaMap = map || {}; })
              .withFailureHandler(function (e) {
                console.error('getSchoolAreaMap failed:', e);
                alert('教室エリア対応表の再取得に失敗しました。画面を再読み込みしてください: ' + gasErrorText_(e));
              })
              .getSchoolAreaMap();
          }
        }).catch(function (e) {
          if (isAuthRequiredError_(e)) return;
          alert('保存でエラーが発生しました: ' + gasErrorText_(e));
        });
      });
    }

    // ==== 共通ユーティリティ ====
    function formatDate(v) {
      if (!v) return '';
      const d = new Date(v);
      if (isNaN(d)) return v;
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    function toDateInputValue_(v) {
      if (!v) return '';
      const d = new Date(v);
      if (isNaN(d)) return '';
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    function escapeHtml_(s) {
      return (s || '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeAttr_(s) {
      return escapeHtml_(s).replace(/"/g, '&quot;');
    }

    // 半角文字（ASCII・半角カナ）を0.5、それ以外（全角）を1として数えた全角換算の文字数
    function zenkakuLength_(s) {
      s = (s || '').toString();
      let units = 0;
      for (const ch of s) {
        const code = ch.codePointAt(0);
        const isHalfWidth = (code >= 0x0000 && code <= 0x00FF) || (code >= 0xFF61 && code <= 0xFF9F);
        units += isHalfWidth ? 1 : 2;
      }
      return units / 2;
    }

    // ふりがな・生徒名セル：全角8文字以内は通常サイズ1行、9文字以上は縮小して2行に折り返す（省略しない）
    function buildWrapCellHtml_(text) {
      text = text || '';
      const cls = zenkakuLength_(text) > 8 ? 'wrapCell small' : 'wrapCell';
      return '<div class="' + cls + '">' + escapeHtml_(text) + '</div>';
    }

    // ==== 保留メール（営業の疑い）確認: 文言定義 ====
    // 理由コード（A/B）・操作失敗時のerrorCodeを利用者向けの日本語に変換する。
    // 件数表示・確認パネル本体は後続のコミットで追加する。

    const SPAM_HOLD_REASON_TEXT_ = {
      A: 'URLあり・体験会ではない、または100文字以上',
      B: '体験会ではない・200文字以上'
    };

    function spamHoldReasonText_(reason) {
      return SPAM_HOLD_REASON_TEXT_[reason] || (reason || '');
    }

    // importSpamHold/discardSpamHoldが返すerrorCode→利用者向け文言（GAS側は例外を投げず{success:false,errorCode}で返す前提）
    function spamHoldActionErrorText_(code) {
      const MAP = {
        ALREADY_PROCESSED: 'すでに処理されています。一覧を更新します',
        MESSAGE_NOT_FOUND: '元のメールが見つかりません（Gmailで削除された可能性があります）',
        NOT_FOUND: '対象が見つかりません。一覧を更新してください',
        INVALID_ID: '対象が見つかりません。一覧を更新してください',
        REGISTER_FAILED: '取り込みに失敗しました。もう一度お試しください',
        TRASH_FAILED: '破棄に失敗しました。もう一度お試しください',
        LOCK_TIMEOUT: 'ほかの操作が処理中です。少し待ってから、もう一度お試しください'
      };
      return MAP[code] || '処理に失敗しました';
    }

    // AUTH_REQUIREDはcallGasAsync_(=callGas)内部で既にログイン画面表示が行われているため、
    // ここで改めてエラー文言を重ねて出さない（他のwithFailureHandler呼び出しと同じ方針）
    function isAuthRequiredError_(err) {
      return !!(err && err.code === 'AUTH_REQUIRED');
    }

    // ==== 保留メール（営業の疑い）確認: 件数表示（集計カード・エリアタブのバッジ・一覧上のバナー） ====
    // 定期的な自動更新は行わず、初期ロード後の1回・ダッシュボードタブを開いた時・一覧の再読み込みボタン・
    // 取り込み/破棄の成功後にのみ件数を取り直す（loop/setIntervalは使わない）。確認パネル本体は後続のコミットで追加する。

    function refreshSpamHoldCounts_() {
      return callGasAsync_('getSpamHoldCounts').then(function (counts) {
        spamHoldCounts_ = (counts && typeof counts === 'object') ? counts : { total: 0, byArea: {} };
        spamHoldCountsLoaded_ = true;
        renderSpamHoldCard_();
        renderAreaTabs_(); // バッジの再描画とあわせて、末尾でupdateSpamHoldBanner_()も呼ばれる
      }).catch(function (err) {
        if (isAuthRequiredError_(err)) return;
        console.error('[KcbBoard] getSpamHoldCounts failed:', err && err.code, err && err.message);
        spamHoldCountsLoaded_ = false; // 失敗時はカード・バッジ・バナーを一切出さない
        renderSpamHoldCard_();
        renderAreaTabs_();
      });
    }

    function spamHoldCountForArea_(area) {
      if (!spamHoldCountsLoaded_) return 0;
      if (area === '') return spamHoldCounts_.total || 0;
      return (spamHoldCounts_.byArea && spamHoldCounts_.byArea[area]) || 0;
    }

    function renderSpamHoldCard_() {
      const card = document.getElementById('statCard-spamHold');
      const btn = document.getElementById('spamHoldCardBtn');
      if (!card || !btn) return;
      if (!spamHoldCountsLoaded_) {
        card.classList.add('isHidden');
        return;
      }
      const total = spamHoldCounts_.total || 0;
      document.getElementById('stat-spamHold').textContent = total;
      card.classList.remove('isHidden');
      card.classList.toggle('statCard-alert', total > 0);
      btn.classList.toggle('isHidden', total === 0);
    }

    function updateSpamHoldBanner_() {
      const banner = document.getElementById('spamHoldBanner');
      if (!banner) return;
      const count = spamHoldCountForArea_(currentAreaFilter);
      if (!spamHoldCountsLoaded_ || count <= 0) {
        banner.classList.add('isHidden');
        return;
      }
      document.getElementById('spamHoldBannerText').textContent =
        'このエリアに、保留中のメールが' + count + '件あります（営業の疑い。まだ一覧には入っていません）';
      banner.classList.remove('isHidden');
    }

    // 一覧の「再読み込み」ボタン専用（一覧の再取得とあわせて保留件数も更新する）
    function reloadListAndSpamHold_() {
      const btn = document.getElementById('reloadListBtn');
      withBusy_('listOps', listOpsScopeButtons_(), btn, '読み込み中…', function () {
        return Promise.all([loadRecords(), refreshSpamHoldCounts_()]);
      });
    }

    // ==== 保留メール（営業の疑い）確認: 確認パネル（モーダル） ====

    function spamHoldPanelAreaLabel_() {
      return currentAreaFilter || '全エリア';
    }

    function visibleSpamHoldList_() {
      if (!currentAreaFilter) return spamHoldList_;
      return spamHoldList_.filter(function (item) { return item.area === currentAreaFilter; });
    }

    function openSpamHoldPanel_() {
      showModal_('spamHoldModalOverlay');
      loadSpamHoldPanelList_();
    }

    function closeSpamHoldPanel_() {
      hideModal_('spamHoldModalOverlay');
    }

    function loadSpamHoldPanelList_() {
      const container = document.getElementById('spamHoldRowsContainer');
      container.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'spamHoldEmpty';
      loading.textContent = '読み込み中...';
      container.appendChild(loading);

      callGasAsync_('getSpamHoldList').then(function (list) {
        spamHoldList_ = list || [];
        renderSpamHoldPanelTitle_();
        renderSpamHoldRows_();
      }).catch(function (err) {
        if (isAuthRequiredError_(err)) return;
        container.innerHTML = '';
        const p = document.createElement('div');
        p.className = 'spamHoldEmpty';
        p.textContent = '読み込みに失敗しました: ' + gasErrorText_(err);
        container.appendChild(p);
      });
    }

    function renderSpamHoldPanelTitle_() {
      document.getElementById('spamHoldModalTitle').textContent =
        '保留メールの確認（' + spamHoldPanelAreaLabel_() + ' ' + visibleSpamHoldList_().length + '件）';
    }

    function renderSpamHoldRows_() {
      const container = document.getElementById('spamHoldRowsContainer');
      container.innerHTML = '';
      const list = visibleSpamHoldList_();
      if (list.length === 0) {
        const p = document.createElement('div');
        p.className = 'spamHoldEmpty';
        p.textContent = '保留中のメールはありません';
        container.appendChild(p);
        return;
      }
      list.forEach(function (item) { container.appendChild(buildSpamHoldRowEl_(item)); });
    }

    function buildSpamHoldRowEl_(item) {
      const row = document.createElement('div');
      row.className = 'spamHoldRow';
      row.dataset.spamId = item.id;

      const meta = document.createElement('div');
      meta.className = 'spamHoldRowMeta';
      meta.innerHTML =
        '<span class="spamHoldMetaItem">' + escapeHtml_(formatDate(item.receivedAt)) + '</span>' +
        '<span class="spamHoldMetaItem">' + escapeHtml_(item.school || '') + '</span>' +
        '<span class="spamHoldMetaItem">' + typeBadge_(item.kubun) + '</span>' +
        '<span class="spamHoldReason">理由: ' + escapeHtml_(spamHoldReasonText_(item.reason)) + '</span>';
      row.appendChild(meta);

      const preview = document.createElement('div');
      preview.className = 'spamHoldPreview';
      preview.textContent = item.questionPreview || '';
      row.appendChild(preview);

      const actions = document.createElement('div');
      actions.className = 'spamHoldActions';
      actions.innerHTML =
        '<button type="button" class="btnPrimary" data-action="importSpamHoldRow_" data-arg="' + escapeAttr_(item.id) + '">問い合わせとして取り込む</button>' +
        '<button type="button" class="btnSecondary" data-action="discardSpamHoldRow_" data-arg="' + escapeAttr_(item.id) + '">営業として破棄</button>' +
        '<button type="button" class="btnSecondary" data-action="toggleSpamHoldBody_" data-arg="' + escapeAttr_(item.id) + '">本文を表示</button>';
      row.appendChild(actions);

      const body = document.createElement('div');
      body.className = 'spamHoldBody isHidden';
      row.appendChild(body);

      return row;
    }

    function toggleSpamHoldBody_(buttonEl, id) {
      const row = buttonEl.closest('.spamHoldRow');
      if (!row) return;
      const body = row.querySelector('.spamHoldBody');
      if (!body) return;

      if (!body.classList.contains('isHidden')) {
        body.classList.add('isHidden');
        return;
      }

      if (Object.prototype.hasOwnProperty.call(spamHoldQuestionFullCache_, id)) {
        body.textContent = spamHoldQuestionFullCache_[id];
        body.classList.remove('isHidden');
        return;
      }

      body.textContent = '読み込み中...';
      body.classList.remove('isHidden');
      callGasAsync_('getSpamHoldQuestionFull', [id]).then(function (res) {
        if (!res || !res.success) {
          body.textContent = spamHoldActionErrorText_(res && res.errorCode);
          return;
        }
        spamHoldQuestionFullCache_[id] = res.question || '';
        body.textContent = spamHoldQuestionFullCache_[id];
      }).catch(function (err) {
        if (isAuthRequiredError_(err)) return;
        body.textContent = gasErrorText_(err);
      });
    }

    function setSpamHoldRowBusy_(row, busy) {
      row.querySelectorAll('button').forEach(function (btn) { btn.disabled = busy; });
      let indicator = row.querySelector('.spamHoldBusyIndicator');
      if (busy) {
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.className = 'spamHoldBusyIndicator';
          row.appendChild(indicator);
        }
        indicator.textContent = '処理中...';
      } else if (indicator) {
        indicator.remove();
      }
    }

    function handleSpamHoldActionError_(code) {
      alert(spamHoldActionErrorText_(code));
      if (code === 'ALREADY_PROCESSED') {
        loadSpamHoldPanelList_();
        refreshSpamHoldCounts_();
      }
    }

    function importSpamHoldRow_(buttonEl, id) {
      const row = buttonEl.closest('.spamHoldRow');
      if (!row) return;
      setSpamHoldRowBusy_(row, true);
      callGasAsync_('importSpamHold', [id]).then(function (res) {
        if (!res || !res.success) {
          setSpamHoldRowBusy_(row, false);
          handleSpamHoldActionError_(res && res.errorCode);
          return;
        }
        spamHoldList_ = spamHoldList_.filter(function (it) { return it.id !== id; });
        delete spamHoldQuestionFullCache_[id];
        row.remove();
        renderSpamHoldPanelTitle_();
        refreshSpamHoldCounts_();
        loadRecords(); // 取り込みの場合のみ、受付一覧を再読み込みする
      }).catch(function (err) {
        setSpamHoldRowBusy_(row, false);
        if (isAuthRequiredError_(err)) return;
        alert(gasErrorText_(err));
      });
    }

    function discardSpamHoldRow_(buttonEl, id) {
      if (!confirm('このメールを破棄します（Gmailのゴミ箱へ移動し、30日間は戻せます）。よろしいですか？')) return;
      const row = buttonEl.closest('.spamHoldRow');
      if (!row) return;
      setSpamHoldRowBusy_(row, true);
      callGasAsync_('discardSpamHold', [id]).then(function (res) {
        if (!res || !res.success) {
          setSpamHoldRowBusy_(row, false);
          handleSpamHoldActionError_(res && res.errorCode);
          return;
        }
        spamHoldList_ = spamHoldList_.filter(function (it) { return it.id !== id; });
        delete spamHoldQuestionFullCache_[id];
        row.remove();
        renderSpamHoldPanelTitle_();
        refreshSpamHoldCounts_();
      }).catch(function (err) {
        setSpamHoldRowBusy_(row, false);
        if (isAuthRequiredError_(err)) return;
        alert(gasErrorText_(err));
      });
    }

    // 段階2-3b: ログイン成功後にapp.js(起動オーケストレーター)からinit(bootstrap)を呼ぶ。
    // board.js自身はここでは自動実行しない。
    function startSplashSequence_() {
      setTimeout(function () {
        var el = document.getElementById('splashScreen');
        if (!el) return;
        el.classList.add('splashHide');
        setTimeout(function () { el.remove(); }, 500);
      }, 1300);
    }

    window.KcbBoard = { init: init };


// ==== 段階2-3b: インラインイベントハンドラ(onclick/onchange)の委譲先 ====
// 37箇所のインラインハンドラを data-action / data-change-action に置き換え、
// ここで定義する明示的なマップ経由でのみ呼び出す（eval・window[name]任意呼び出しはしない）。
var CLICK_ACTIONS = {
  switchTab: function (el, arg) { switchTab(arg); },
  openRegisterModal: function () { openRegisterModal(); },
  showTrashView_: function () { showTrashView_(); },
  setDateFilterShortcut_: function (el, arg) { setDateFilterShortcut_(arg); },
  clearDateFilter_: function () { clearDateFilter_(); },
  loadRecords: function () { loadRecords(); },
  toggleOnlySelected_: function () { toggleOnlySelected_(); },
  moveSelectedToTrash: function () { moveSelectedToTrash(); },
  toggleSort_: function () { toggleSort_(); },
  showListView_: function () { showListView_(); },
  loadDashboard: function () { loadDashboard(); },
  openKpiChart_: function (el, arg) { openKpiChart_(arg); },
  saveEnrollmentInputs_: function () { saveEnrollmentInputs_(); },
  loadMasterList: function () { loadMasterList(); },
  reloadMasterList_: function () { reloadMasterList_(); },
  addMasterRow: function () { addMasterRow(); },
  saveMasterList: function () { saveMasterList(); },
  setRegisterMode_: function (el, arg) { setRegisterMode_(arg); },
  setRateCompareScope_: function (el, arg) { setRateCompareScope_(arg); },
  removeRow: function (el) { el.closest('tr').remove(); },
  reloadListAndSpamHold_: function () { reloadListAndSpamHold_(); },
  openSpamHoldPanel_: function () { openSpamHoldPanel_(); },
  toggleSpamHoldBody_: function (el, arg) { toggleSpamHoldBody_(el, arg); },
  importSpamHoldRow_: function (el, arg) { importSpamHoldRow_(el, arg); },
  discardSpamHoldRow_: function (el, arg) { discardSpamHoldRow_(el, arg); }
};

var CHANGE_ACTIONS = {
  loadRecords: function () { loadRecords(); },
  onDateFilterChange_: function () { onDateFilterChange_(); },
  loadMasterList: function () { loadMasterList(); },
  updateContactCheck: function (el) { updateContactCheck(el); }
};

// data-action="stopPropagation" は、行(tr)のクリックで編集モーダルが開くのを防ぐためのもの。
// 元のonclick="event.stopPropagation()"は要素自身にその場で効くため、委譲リスナーで同じ
// タイミングを再現するにはキャプチャフェーズで止める必要がある（バブルフェーズで止めても、
// 既にtr.onclickの方が先に発火してしまい手遅れになる）。
document.addEventListener('click', function (e) {
  var stopEl = e.target.closest('[data-action="stopPropagation"]');
  if (stopEl) {
    e.stopPropagation();
    return;
  }
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var fn = CLICK_ACTIONS[el.getAttribute('data-action')];
  if (!fn) return;
  fn(el, el.getAttribute('data-arg'));
}, true);

document.addEventListener('change', function (e) {
  var el = e.target.closest('[data-change-action]');
  if (!el) return;
  var fn = CHANGE_ACTIONS[el.getAttribute('data-change-action')];
  if (!fn) return;
  fn(el, el.getAttribute('data-arg'));
});
