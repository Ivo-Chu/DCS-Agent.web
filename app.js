/* DCS 智能体网页端 · app.js（原生 JS，零依赖）
   会话列表与消息记录存 localStorage（每工号隔离）；
   服务端每工号一个 Agent 上下文，「开启新会话」调用 /api/reset 清空。 */

(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };

  var TOOL_LABELS = {
    query_dcs_data: "查询 DCS 数据库",
    investigate_dcs_code: "调查 DCS 源码"
  };

  var state = {
    token: localStorage.getItem("dcs-web-token") || "",
    identity: null,          // { name, employeeNo, department }
    convs: [],               // [{ id, title, createdAt, messages:[{role,text,steps,error}] }]
    activeId: null,
    running: false,
    abort: null
  };

  // ---------------------------------------------------------------- 工具

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function convStoreKey() {
    return "dcs-web-convs-" + (state.identity ? state.identity.employeeNo : "anon");
  }

  function saveConvs() {
    try { localStorage.setItem(convStoreKey(), JSON.stringify({ convs: state.convs, activeId: state.activeId })); } catch (e) { /* 存储满等异常忽略 */ }
  }

  function loadConvs() {
    try {
      var raw = localStorage.getItem(convStoreKey());
      if (!raw) return;
      var data = JSON.parse(raw);
      state.convs = Array.isArray(data.convs) ? data.convs : [];
      state.activeId = data.activeId || null;
    } catch (e) { state.convs = []; state.activeId = null; }
  }

  function activeConv() {
    for (var i = 0; i < state.convs.length; i++) {
      if (state.convs[i].id === state.activeId) return state.convs[i];
    }
    return null;
  }

  function isLiveConv() {
    // 只有最新会话是"活"的（服务端只保留当前上下文）；历史会话只读
    return state.convs.length > 0 && state.convs[0].id === state.activeId;
  }

  // ---------------------------------------------------------------- 极简 Markdown 渲染
  // 子集：段落 / 换行 / **加粗** / `代码` / 表格 / 无序与有序列表

  function inlineMd(s) {
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }

  function renderMarkdown(src) {
    var lines = String(src).split("\n");
    var html = "";
    var i = 0;
    var isSep = function (l) { return /^\s*\|[\s:|-]+\|\s*$/.test(l); };
    var isRow = function (l) { return /^\s*\|.*\|\s*$/.test(l); };
    var cells = function (l) {
      return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
    };

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      // 表格：表头行 + 分隔行
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        var head = cells(line);
        i += 2;
        var bodyRows = [];
        while (i < lines.length && isRow(lines[i])) { bodyRows.push(cells(lines[i])); i++; }
        html += "<table><thead><tr>" + head.map(function (c) { return "<th>" + inlineMd(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
        bodyRows.forEach(function (r) {
          html += "<tr>" + r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") + "</tr>";
        });
        html += "</tbody></table>";
        continue;
      }

      // 无序列表
      if (/^\s*[-•]\s+/.test(line)) {
        html += "<ul>";
        while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) {
          html += "<li>" + inlineMd(lines[i].replace(/^\s*[-•]\s+/, "")) + "</li>";
          i++;
        }
        html += "</ul>";
        continue;
      }

      // 有序列表
      if (/^\s*\d+[.、)]\s+/.test(line)) {
        html += "<ol>";
        while (i < lines.length && /^\s*\d+[.、)]\s+/.test(lines[i])) {
          html += "<li>" + inlineMd(lines[i].replace(/^\s*\d+[.、)]\s+/, "")) + "</li>";
          i++;
        }
        html += "</ol>";
        continue;
      }

      // 段落（合并到空行为止，段内换行转 <br>）
      var para = [];
      while (i < lines.length && lines[i].trim() && !isRow(lines[i]) && !/^\s*[-•]\s+/.test(lines[i]) && !/^\s*\d+[.、)]\s+/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += "<p>" + para.map(inlineMd).join("<br>") + "</p>";
    }
    return html;
  }

  // ---------------------------------------------------------------- 渲染

  function renderIdentity() {
    var id = state.identity;
    $("#identityBox").innerHTML =
      '<p class="name">' + esc(id.name) + '<span class="no">' + esc(id.employeeNo) + "</span></p>" +
      '<p class="dept">' + esc(id.department || "未知部门") + "</p>";
  }

  function renderConvList() {
    var box = $("#convList");
    box.innerHTML = "";
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var groups = [
      { label: "今天", items: [] },
      { label: "更早", items: [] }
    ];
    state.convs.forEach(function (c) {
      groups[c.createdAt >= today.getTime() ? 0 : 1].items.push(c);
    });
    groups.forEach(function (g) {
      if (!g.items.length) return;
      var label = document.createElement("div");
      label.className = "conv-group";
      label.textContent = g.label;
      box.appendChild(label);
      g.items.forEach(function (c) {
        var item = document.createElement("div");
        item.className = "conv-item" + (c.id === state.activeId ? " active" : "");
        item.textContent = c.title;
        item.onclick = function () { switchConv(c.id); };
        box.appendChild(item);
      });
    });
  }

  function traceHtml(msg, running) {
    if (!msg.steps || !msg.steps.length) return "";
    var summary = {};
    msg.steps.forEach(function (s) {
      var label = TOOL_LABELS[s.name] || s.name;
      summary[label] = (summary[label] || 0) + 1;
    });
    var parts = Object.keys(summary).map(function (k) {
      return summary[k] > 1 ? k + " ×" + summary[k] : k;
    });
    var text = running
      ? "正在查询…"
      : "已完成 " + msg.steps.length + " 步查询 · " + parts.join("、");
    var h = '<div class="trace' + (running ? " running" : "") + '" data-trace>' +
      '<span class="trace-dot"></span><span data-trace-text>' + esc(text) + "</span>" +
      '<span class="trace-toggle">▾</span></div>';
    h += '<div class="trace-steps" data-trace-steps hidden>' + msg.steps.map(function (s) {
      return '<div class="step' + (s.isError ? " fail" : "") + '">' +
        esc(TOOL_LABELS[s.name] || s.name) + (s.isError ? "（失败）" : "") + "</div>";
    }).join("") + "</div>";
    return h;
  }

  function bindTrace(row) {
    var trace = row.querySelector("[data-trace]");
    if (!trace) return;
    trace.onclick = function () {
      var steps = row.querySelector("[data-trace-steps]");
      if (steps) steps.hidden = !steps.hidden;
    };
  }

  function renderMessages() {
    var box = $("#messages");
    box.innerHTML = "";
    var conv = activeConv();
    $("#convTitle").textContent = conv ? conv.title : "新会话";
    $("#readonlyBar").hidden = !(conv && !isLiveConv());
    $(".composer-wrap").classList.toggle("disabled", !!(conv && !isLiveConv()));

    if (!conv || !conv.messages.length) {
      box.innerHTML = '<div class="welcome"><h2>你好，我是 DCS 智能体</h2>' +
        "<p>可以问我报餐、考勤、菜单权限等 DCS 系统相关问题，我会查询真实数据和系统源码来回答。</p></div>";
      return;
    }
    conv.messages.forEach(function (m) {
      box.appendChild(buildMsgRow(m, false));
      bindTrace(box.lastChild);
    });
    box.scrollTop = box.scrollHeight;
  }

  function buildMsgRow(m, running) {
    var row = document.createElement("div");
    row.className = "msg-row";
    if (m.role === "user") {
      row.innerHTML = '<div class="msg-user">' + esc(m.text) + "</div>";
    } else if (m.role === "error") {
      row.innerHTML = '<div class="msg-error">' + esc(m.text) + "</div>";
    } else {
      row.innerHTML = '<div class="msg-assistant">' + traceHtml(m, running) +
        '<div class="msg-content" data-content>' + renderMarkdown(m.text || "") +
        (running ? '<span class="cursor"></span>' : "") + "</div></div>";
    }
    return row;
  }

  // ---------------------------------------------------------------- 会话操作

  function switchConv(id) {
    if (state.running) return;
    state.activeId = id;
    saveConvs();
    renderConvList();
    renderMessages();
  }

  function newConv() {
    if (state.running) return;
    // 通知服务端丢弃当前 Agent 上下文（失败不阻塞，本地照常开新会话）
    if (state.token) {
      fetch("/api/reset", { method: "POST", headers: { Authorization: "Bearer " + state.token } }).catch(function () {});
    }
    var conv = { id: uid(), title: "新会话", createdAt: Date.now(), messages: [] };
    state.convs.unshift(conv);
    state.activeId = conv.id;
    saveConvs();
    renderConvList();
    renderMessages();
    $("#input").focus();
  }

  function ensureConv() {
    var conv = activeConv();
    if (conv && isLiveConv()) return conv;
    conv = { id: uid(), title: "新会话", createdAt: Date.now(), messages: [] };
    state.convs.unshift(conv);
    state.activeId = conv.id;
    return conv;
  }

  // ---------------------------------------------------------------- 发送与 SSE

  function setRunning(running) {
    state.running = running;
    $("#sendBtn").textContent = running ? "■" : "↑";
    $("#sendBtn").title = running ? "停止" : "发送";
    $("#input").disabled = running;
  }

  async function send() {
    if (state.running) { // 停止
      if (state.abort) state.abort.abort();
      return;
    }
    var question = $("#input").value.trim();
    if (!question) return;

    var conv = ensureConv();
    if (conv.title === "新会话") conv.title = question.slice(0, 12);
    conv.messages.push({ role: "user", text: question });
    var assistant = { role: "assistant", text: "", steps: [] };
    conv.messages.push(assistant);

    $("#input").value = "";
    $("#input").style.height = "auto";
    renderConvList();
    renderMessages();

    var box = $("#messages");
    var row = buildMsgRow(assistant, true);
    box.appendChild(row);
    bindTrace(row);
    box.scrollTop = box.scrollHeight;

    setRunning(true);
    state.abort = new AbortController();

    try {
      var resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
        body: JSON.stringify({ question: question }),
        signal: state.abort.signal
      });
      if (resp.status === 401) { backToLogin("会话已失效，请重新输入工号。"); return; }
      if (!resp.ok || !resp.body) {
        var errText = "";
        try { errText = (await resp.json()).message || ""; } catch (e) { /* 忽略 */ }
        throw new Error(errText || "请求失败（HTTP " + resp.status + "）");
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var dataLine = frame.split("\n").filter(function (l) { return l.indexOf("data:") === 0; })[0];
          if (!dataLine) continue;
          var ev;
          try { ev = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
          try {
            handleEvent(ev, assistant, row, box);
          } catch (handleErr) {
            // 单个事件处理失败不阻断流式读取，但必须在控制台留证（F12 可见）
            console.error("[DCS] 处理事件失败（type=" + (ev && ev.type) + "）：", handleErr);
          }
        }
      }
      if (!assistant.text && !assistant.error) assistant.text = "这次查询未能生成回复，请稍后重试。";
    } catch (err) {
      if (err && err.name === "AbortError") {
        // 用户主动停止：保留已生成的部分内容
        if (!assistant.text) {
          conv.messages.splice(conv.messages.indexOf(assistant), 1);
        }
      } else {
        assistant.role = "error";
        assistant.text = (err && err.message) || "处理出现问题，请稍后重试。";
        // 控制台留完整堆栈（F12 → Console 可见），便于定位原始异常来源
        console.error("[DCS] 提问异常：", err);
      }
    } finally {
      setRunning(false);
      state.abort = null;
      saveConvs();
      renderMessages();
    }
  }

  function handleEvent(ev, assistant, row, box) {
    var content = row.querySelector("[data-content]");
    if (ev.type === "delta") {
      assistant.text += ev.text;
      content.innerHTML = renderMarkdown(assistant.text) + '<span class="cursor"></span>';
      box.scrollTop = box.scrollHeight;
    } else if (ev.type === "tool_step") {
      if (ev.status === "start") {
        assistant.steps.push({ name: ev.name, isError: false });
      } else {
        // end：回填最近一个同名未结束步骤的成败
        for (var i = assistant.steps.length - 1; i >= 0; i--) {
          if (assistant.steps[i].name === ev.name) { assistant.steps[i].isError = !!ev.isError; break; }
        }
      }
      refreshTrace(row, assistant, true);
    } else if (ev.type === "final") {
      assistant.text = ev.text || assistant.text;
      content.innerHTML = renderMarkdown(assistant.text);
      refreshTrace(row, assistant, false);
    } else if (ev.type === "timeout" || ev.type === "error" || ev.type === "busy") {
      assistant.role = "error";
      assistant.text = ev.message || "处理出现问题，请稍后重试。";
    }
  }

  function refreshTrace(row, assistant, running) {
    var old = row.querySelector(".trace");
    var oldSteps = row.querySelector(".trace-steps");
    var expanded = oldSteps && !oldSteps.hidden;
    if (old) old.remove();
    if (oldSteps) oldSteps.remove();
    var content = row.querySelector("[data-content]");
    var tmp = document.createElement("div");
    tmp.innerHTML = traceHtml(assistant, running);
    while (tmp.firstChild) content.parentNode.insertBefore(tmp.firstChild, content);
    if (expanded) {
      var steps = row.querySelector("[data-trace-steps]");
      if (steps) steps.hidden = false;
    }
    bindTrace(row);
  }

  // ---------------------------------------------------------------- 登录

  function backToLogin(message) {
    localStorage.removeItem("dcs-web-token");
    state.token = "";
    state.identity = null;
    $("#appView").hidden = true;
    $("#loginView").hidden = false;
    if (message) { $("#loginError").textContent = message; $("#loginError").hidden = false; }
  }

  async function login() {
    var code = $("#codeInput").value.trim();
    if (!code) { $("#loginError").textContent = "请输入工号"; $("#loginError").hidden = false; return; }
    $("#loginBtn").disabled = true;
    $("#loginError").hidden = true;
    try {
      var resp = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code })
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.message || "未能识别该工号");
      state.token = data.token;
      state.identity = { name: data.name, employeeNo: data.employeeNo, department: data.department };
      localStorage.setItem("dcs-web-token", data.token);
      localStorage.setItem("dcs-web-identity", JSON.stringify(state.identity));
      enterApp();
    } catch (err) {
      $("#loginError").textContent = (err && err.message) || "网络异常，请稍后重试。";
      $("#loginError").hidden = false;
    } finally {
      $("#loginBtn").disabled = false;
    }
  }

  function enterApp() {
    $("#loginView").hidden = true;
    $("#appView").hidden = false;
    renderIdentity();
    loadConvs();
    if (!state.convs.length) newConv(); else { renderConvList(); renderMessages(); }
  }

  // ---------------------------------------------------------------- 启动

  function init() {
    var savedIdentity = null;
    try { savedIdentity = JSON.parse(localStorage.getItem("dcs-web-identity") || "null"); } catch (e) { /* 忽略 */ }
    if (state.token && savedIdentity) {
      state.identity = savedIdentity;
      enterApp();
    } else {
      backToLogin();
    }

    $("#loginBtn").onclick = login;
    $("#codeInput").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
    $("#newChatBtn").onclick = newConv;
    $("#sendBtn").onclick = send;

    var input = $("#input");
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 160) + "px";
    });
  }

  init();
})();
