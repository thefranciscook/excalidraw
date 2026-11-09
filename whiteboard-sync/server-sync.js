// Gives each board (/b/<id>) its own localStorage scene and mirrors it to the
// server (/api/boards/<id>). Loaded as a classic script before the Excalidraw
// bundle, so the board's server copy is in place by the time Excalidraw boots.
//
// The server merges saves per element (scene.js), and others (Claude, through
// the connector, or another device) may change the board while it's open
// here. Their changes are picked up within a couple of seconds and merged into
// the open scene through hooks the app sets (wbMergeRemote, wbGetElements in
// excalidraw-app App.tsx).
//
// It also shows messages under the toolbar (image saving, Claude at work on
// the board), each of which can be closed.
(function () {
  var match = location.pathname.match(/^\/b\/([a-z0-9]{10})\/?$/);
  if (!match) {
    location.replace("/");
    return;
  }
  var BOARD = match[1];
  var API = "/api/boards/" + BOARD;

  // Excalidraw keeps its scene under fixed keys. Namespace them per board so
  // tabs with different boards open don't overwrite each other.
  var SCENE_KEYS = { excalidraw: 1, "excalidraw-state": 1, "version-dataState": 1 };
  var ns = function (key) {
    return SCENE_KEYS[key] ? key + ":" + BOARD : key;
  };
  var proto = Storage.prototype;
  var rawGet = proto.getItem;
  var rawSet = proto.setItem;
  var rawRemove = proto.removeItem;
  proto.getItem = function (key) {
    return rawGet.call(this, this === localStorage ? ns(key) : key);
  };
  proto.setItem = function (key, value) {
    return rawSet.call(this, this === localStorage ? ns(key) : key, value);
  };
  proto.removeItem = function (key) {
    return rawRemove.call(this, this === localStorage ? ns(key) : key);
  };

  var get = function (key) {
    return localStorage.getItem(key);
  };
  var set = function (key, value) {
    localStorage.setItem(key, value);
  };
  var localVersion = function () {
    return JSON.parse(get("version-dataState") || "-1");
  };

  // savedAt of the last state the server has, remembered across reloads so
  // unpushed edits survive a page reload while offline.
  var SYNCED_KEY = "wb-synced:" + BOARD;
  var serverVersion = JSON.parse(rawGet.call(localStorage, SYNCED_KEY) || "-1");
  var setServerVersion = function (v) {
    serverVersion = v;
    rawSet.call(localStorage, SYNCED_KEY, JSON.stringify(v));
  };

  // the board's server revision this tab has (see GET /api/boards/<id>/head)
  var knownRev = -1;

  // Replaces the local copy with the server's (before boot, or when the app's
  // merge hook isn't there). Versions are this browser's clock, like the
  // app's own saves, so later local saves always count as newer.
  var applyServerScene = function (scene) {
    var now = Date.now();
    set("excalidraw", JSON.stringify((scene.elements || []).filter(function (el) {
      return !el.isDeleted;
    })));
    set("excalidraw-state", JSON.stringify(scene.appState || {}));
    set("version-dataState", JSON.stringify(now));
    setServerVersion(now);
    if (typeof scene.rev === "number") knownRev = scene.rev;
  };

  // Drop cached copies of other boards that are fully synced, to stay well
  // under the browser's ~5 MB localStorage quota.
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      var m = key && key.match(/^wb-synced:([a-z0-9]{10})$/);
      if (!m || m[1] === BOARD) continue;
      var other = m[1];
      var v = JSON.parse(rawGet.call(localStorage, "version-dataState:" + other) || "-1");
      if (v <= JSON.parse(rawGet.call(localStorage, key) || "-1")) {
        rawRemove.call(localStorage, "excalidraw:" + other);
        rawRemove.call(localStorage, "excalidraw-state:" + other);
        rawRemove.call(localStorage, "version-dataState:" + other);
        rawRemove.call(localStorage, key);
      }
    }
  } catch (e) {
    console.error("[server-sync] cleanup failed", e);
  }

  // Images from imported .excalidraw files are kept on the board as `files`.
  // Excalidraw reloads images missing from the canvas on window focus, when
  // version-files is newer than its own.
  var notifyTimer = null;
  var notifyExcalidraw = function () {
    rawSet.call(localStorage, "version-files", JSON.stringify(Date.now()));
    window.dispatchEvent(new Event("focus"));
    // again later, in case Excalidraw wasn't listening yet
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(function () {
      window.dispatchEvent(new Event("focus"));
    }, 2000);
  };

  // Put any missing ones into Excalidraw's image store (IndexedDB "files-db",
  // same layout as idb-keyval's createStore), then have it reload images.
  // Calls back with an error, or null once the files are stored.
  var storeFiles = function (files, done, quiet) {
    var finish = function (err, added) {
      if (added && !quiet) notifyExcalidraw();
      if (done) done(err);
    };
    var req = indexedDB.open("files-db");
    req.onupgradeneeded = function () {
      req.result.createObjectStore("files-store");
    };
    req.onsuccess = function () {
      var db = req.result;
      var tx = db.transaction("files-store", "readwrite");
      var store = tx.objectStore("files-store");
      var added = 0;
      Object.keys(files).forEach(function (id) {
        var check = store.count(id);
        check.onsuccess = function () {
          if (!check.result) {
            store.put(files[id], id);
            added++;
          }
        };
      });
      tx.oncomplete = function () {
        db.close();
        finish(null, added);
      };
      // e.g. storage quota exceeded
      tx.onabort = function () {
        db.close();
        console.error("[server-sync] couldn't store images", tx.error);
        finish(tx.error || new Error("transaction aborted"), 0);
      };
    };
    req.onerror = function () {
      console.error("[server-sync] couldn't store images", req.error);
      finish(req.error, 0);
    };
  };

  // Calls back with {id: fileData} for the ids that are in the image store.
  var readFiles = function (ids, cb) {
    var req = indexedDB.open("files-db");
    req.onupgradeneeded = function () {
      req.result.createObjectStore("files-store");
    };
    req.onsuccess = function () {
      var db = req.result;
      var tx = db.transaction("files-store", "readonly");
      var store = tx.objectStore("files-store");
      var found = {};
      ids.forEach(function (id) {
        var read = store.get(id);
        read.onsuccess = function () {
          if (read.result && read.result.dataURL) found[id] = read.result;
        };
      });
      tx.oncomplete = function () {
        db.close();
        cb(found);
      };
      // always call back, or the uploader would wait forever
      tx.onabort = function () {
        db.close();
        console.error("[server-sync] couldn't read images", tx.error);
        cb(found);
      };
    };
    req.onerror = function () {
      console.error("[server-sync] couldn't read images", req.error);
      cb({});
    };
  };

  // fetch with a time limit, so one stalled request can't hold up the rest
  var fetchWithin = function (ms, url, opts) {
    opts = opts || {};
    if (!window.AbortController) return fetch(url, opts);
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, ms);
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(
      function (res) {
        clearTimeout(timer);
        return res;
      },
      function (e) {
        clearTimeout(timer);
        throw e;
      },
    );
  };

  // A request answered by the site login (redirected to its page) instead of
  // /api is not a success, even though it ends in a 200.
  var apiOk = function (res) {
    return res.ok && !res.redirected;
  };

  // fileIds of the board's images, nearest to the middle of the view first
  var imageFileIds = function () {
    var dist = {};
    try {
      var state = JSON.parse(get("excalidraw-state") || "{}");
      var zoom = (state.zoom && state.zoom.value) || 1;
      var cx = -(state.scrollX || 0) + window.innerWidth / 2 / zoom;
      var cy = -(state.scrollY || 0) + window.innerHeight / 2 / zoom;
      JSON.parse(get("excalidraw") || "[]").forEach(function (el) {
        if (el.type !== "image" || !el.fileId || el.isDeleted) return;
        var dx = (el.x || 0) + (el.width || 0) / 2 - cx;
        var dy = (el.y || 0) + (el.height || 0) / 2 - cy;
        var d = dx * dx + dy * dy;
        if (!(el.fileId in dist) || d < dist[el.fileId]) dist[el.fileId] = d;
      });
    } catch (e) {}
    return Object.keys(dist).sort(function (a, b) {
      return dist[a] - dist[b];
    });
  };

  // Image files are stored on the server (in a GitHub repo) by fileId, shared
  // by all boards. `onServer` is null until the server's list is known, and
  // stays null if image storage isn't set up there.
  var FILES_API = "/api/files";
  var onServer = null;
  var retryAt = {};

  // Downloads: a few at a time, each image stored (and shown) as soon as it
  // arrives, so a slow connection or an interrupted download doesn't hold
  // back the rest. Failed downloads are retried with a growing delay.
  var DOWNLOADS_AT_ONCE = 4;
  var downloading = {};
  var downloadRetryAt = {};
  var downloadAttempts = {};
  // ids of the current batch, for "Loading images 3/10"
  var batch = {};
  var batchDone = 0;
  // the board has images that neither this browser nor the server has yet
  // (e.g. another device is still uploading them)
  var waitingForServer = false;
  // the server's image list couldn't be fetched (retried every 15s)
  var listFailed = false;
  // The order for every image added here: 1. save it on this device,
  // 2. upload it, 3. say how that's going. Nothing waits on step 1: the
  // editor hands over its images as they are added (wbOnFiles, from
  // excalidraw-app App.tsx), so an image is uploaded even if saving it on
  // this device fails, and saving it here is retried, which the editor
  // doesn't do.
  var memFiles = {};
  window.wbOnFiles = function (files) {
    memFiles = files || {};
  };

  // Lets the app's clean-up of old images keep the ones the server doesn't
  // have: they may be the only copy (LocalData.ts, clearObsoleteFiles).
  window.wbServerHasFile = function (id) {
    return !!(onServer && onServer[id]);
  };

  // Ask the browser not to clear this site's storage when space runs low.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {}

  // State of the board's images that the server doesn't have yet:
  var notUploaded = {}; // here (on this device or in this tab), not uploaded
  var unstoredSince = {}; // only in this tab, not saved on this device; since when
  var missingSince = {}; // nowhere: not here, not on the server; since when
  var localSaveFailed = false;
  var savedUntil = 0; // show "saved" briefly after the last upload
  // a just-added image takes a moment to reach this device's image store
  var STORE_GRACE_MS = 5000;
  var MISSING_GRACE_MS = 10000;

  var plural = function (n) {
    return n + (n === 1 ? " image" : " images");
  };
  var isAre = function (n) {
    return n === 1 ? " isn't" : " aren't";
  };
  var since = function (map, ms) {
    var now = Date.now();
    return Object.keys(map).filter(function (id) {
      return now - map[id] > ms;
    }).length;
  };

  // --- Messages ---
  // A stack of messages under the toolbar, each with a close button.
  // Progress ("Uploading 2 images…") goes away on its own; warnings stay
  // until they're resolved or closed. A closed message stays closed until
  // what it says changes (its `sig`), or it goes away and comes back.
  var messages = {}; // key -> {text, tone: "info"|"warn"|"claude", sig}
  var MESSAGE_ORDER = ["claude", "images-warn", "images-missing", "images-progress"];
  // closed messages: key -> sig. Those in KEEP_CLOSED stay closed across
  // reloads, so a warning that can't be acted on here doesn't come back on
  // every visit (only when it changes).
  var KEEP_CLOSED = { "images-missing": 1 };
  var DISMISSED_KEY = "wb-dismissed:" + BOARD;
  var dismissed = {};
  try {
    dismissed = JSON.parse(rawGet.call(localStorage, DISMISSED_KEY) || "{}") || {};
  } catch (e) {}
  var saveDismissed = function () {
    var keep = {};
    for (var k in dismissed) if (KEEP_CLOSED[k]) keep[k] = dismissed[k];
    try {
      if (Object.keys(keep).length) rawSet.call(localStorage, DISMISSED_KEY, JSON.stringify(keep));
      else rawRemove.call(localStorage, DISMISSED_KEY);
    } catch (e) {}
  };
  var setMessage = function (key, msg) {
    if (msg) {
      messages[key] = msg;
      return;
    }
    delete messages[key];
    // it's over: when it comes back, show it again
    if (key in dismissed && !KEEP_CLOSED[key]) delete dismissed[key];
  };

  var boxEl = null;
  var msgEls = {};
  var CLOSE_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var renderMessages = function () {
    if (!boxEl) return;
    MESSAGE_ORDER.forEach(function (key, i) {
      var msg = messages[key];
      var el = msgEls[key];
      if (!msg || dismissed[key] === msg.sig) {
        if (el) {
          el.parentNode.removeChild(el);
          delete msgEls[key];
        }
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.innerHTML =
          '<span class="wb-msg-text"></span><button type="button" class="wb-msg-close" aria-label="Close" title="Close">' +
          CLOSE_ICON +
          "</button>";
        el.querySelector("button").addEventListener("click", function () {
          if (messages[key]) dismissed[key] = messages[key].sig;
          saveDismissed();
          renderMessages();
        });
        msgEls[key] = el;
        // in MESSAGE_ORDER, without moving the others (that would drop focus)
        var before = null;
        for (var j = i + 1; j < MESSAGE_ORDER.length && !before; j++) before = msgEls[MESSAGE_ORDER[j]] || null;
        boxEl.insertBefore(el, before);
      }
      el.className = "wb-msg wb-" + msg.tone;
      var textEl = el.querySelector(".wb-msg-text");
      if (textEl.textContent !== msg.text) textEl.textContent = msg.text;
    });
  };

  // a short, stable name for a set of ids
  var hashIds = function (ids) {
    var h = 5381;
    var str = ids.slice().sort().join(",");
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return ids.length + ":" + h.toString(36);
  };

  // Image messages: problems saving them ("images-warn"), images nobody has
  // ("images-missing"), and progress ("images-progress").
  var showStatus = function () {
    var now = Date.now();
    var unsent = Object.keys(notUploaded);
    var failedUploads = unsent.filter(function (id) {
      return retryAt[id] > now;
    }).length;
    var onlyInTab = since(unstoredSince, STORE_GRACE_MS);
    var missingIds = Object.keys(missingSince).filter(function (id) {
      return now - missingSince[id] > MISSING_GRACE_MS;
    });
    var missing = missingIds.length;

    var warn = null;
    if (onlyInTab) {
      warn = {
        sig: "local:" + onlyInTab,
        text:
          plural(onlyInTab) +
          " couldn't be saved on this device" +
          (localSaveFailed ? " (its storage may be full)" : "") +
          " and" +
          isAre(onlyInTab) +
          " on the server yet. Don't close this tab.",
      };
    } else if (failedUploads) {
      // (only claim they're saved here once that's known)
      warn = {
        sig: "upload:" + failedUploads,
        text:
          plural(failedUploads) +
          " couldn't be uploaded yet. Retrying…" +
          (Object.keys(unstoredSince).length ? " Don't close this tab." : " They're saved on this device."),
      };
    } else if (listFailed && unsent.length) {
      warn = {
        sig: "offline",
        text: "Can't reach the server. " + plural(unsent.length) + " saved on this device only, for now. Retrying…",
      };
    }
    if (warn) warn.tone = "warn";
    setMessage("images-warn", warn);

    setMessage(
      "images-missing",
      missing
        ? {
            tone: "warn",
            sig: hashIds(missingIds),
            text:
              plural(missing) +
              " on this board never reached the server and" +
              isAre(missing) +
              " on this device. Open the board where " +
              (missing === 1 ? "it was added to upload it." : "they were added to upload them."),
          }
        : null,
    );

    var progress = null;
    if (Object.keys(downloading).length) {
      progress = { sig: "loading", text: "Loading images " + batchDone + "/" + Object.keys(batch).length };
    } else if (Object.keys(downloadRetryAt).length) {
      progress = { sig: "download-retry", text: plural(Object.keys(downloadRetryAt).length) + " couldn't load. Retrying…" };
    } else if (unsent.length && !warn) {
      progress = { sig: "uploading", text: "Uploading " + plural(unsent.length) + "…" };
    } else if (savedUntil > now) {
      progress = { sig: "saved", text: "Images saved" };
    }
    if (progress) progress.tone = "info";
    setMessage("images-progress", progress);

    if (!Object.keys(downloading).length) {
      batch = {};
      batchDone = 0;
    }
    renderMessages();
  };

  // "Claude is drawing on this board": the server says how long ago Claude
  // (the connector) last drew on or looked at it (GET .../head).
  var CLAUDE_SHOW_MS = 30000;
  var claudeDrewAt = 0;
  var claudeLookedAt = 0;
  var showClaude = function () {
    var now = Date.now();
    var text =
      now - claudeDrewAt < CLAUDE_SHOW_MS
        ? "Claude is drawing on this board…"
        : now - claudeLookedAt < CLAUDE_SHOW_MS
          ? "Claude is looking at this board…"
          : "";
    setMessage("claude", text ? { tone: "claude", sig: "active", text: text } : null);
    renderMessages();
  };
  var noteClaude = function (claude) {
    var now = Date.now();
    if (claude && typeof claude.drewAgo === "number") claudeDrewAt = Math.max(claudeDrewAt, now - claude.drewAgo);
    if (claude && typeof claude.lookedAgo === "number") claudeLookedAt = Math.max(claudeLookedAt, now - claude.lookedAgo);
    showClaude();
  };

  var download = function (id, next) {
    fetchWithin(120000, FILES_API + "/" + id)
      .then(function (res) {
        if (res.status === 404) delete onServer[id];
        if (!apiOk(res)) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (file) {
        return new Promise(function (resolve, reject) {
          var files = {};
          files[id] = file;
          storeFiles(files, function (err) {
            if (err) reject(err);
            else resolve();
          });
        });
      })
      .then(
        function () {
          batchDone++;
          delete downloadRetryAt[id];
          delete downloadAttempts[id];
        },
        function (e) {
          var attempts = (downloadAttempts[id] || 0) + 1;
          downloadAttempts[id] = attempts;
          // no retry if the server doesn't have it; the list is re-checked instead
          if (onServer[id]) downloadRetryAt[id] = Date.now() + Math.min(60000, 5000 * Math.pow(2, attempts - 1));
          else waitingForServer = true;
          console.error("[server-sync] image download failed", id, e);
        },
      )
      .then(function () {
        delete downloading[id];
        showStatus();
        next();
      });
  };

  // Put images the board needs, but this browser doesn't have, into the store.
  var fetchMissingFiles = function () {
    if (!onServer) return;
    var ids = imageFileIds();
    if (!ids.length) return;
    readFiles(ids, function (have) {
      var now = Date.now();
      var missing = {};
      waitingForServer = false;
      ids.forEach(function (id) {
        if (have[id]) return;
        missing[id] = 1;
        if (!onServer[id]) waitingForServer = true;
      });
      // forget failures of images that are no longer needed
      Object.keys(downloadRetryAt).forEach(function (id) {
        if (!missing[id]) delete downloadRetryAt[id];
      });
      var queue = ids.filter(function (id) {
        return missing[id] && onServer[id] && !downloading[id] && !(downloadRetryAt[id] > now);
      });
      queue.forEach(function (id) {
        downloading[id] = 1;
        batch[id] = 1;
      });
      showStatus();
      var next = function () {
        var id = queue.shift();
        if (id) download(id, next);
      };
      for (var i = 0; i < DOWNLOADS_AT_ONCE; i++) next();
    });
  };

  var retryDownloadsIfDue = function () {
    var now = Date.now();
    for (var id in downloadRetryAt) {
      if (downloadRetryAt[id] <= now && !downloading[id]) return fetchMissingFiles();
    }
  };

  // Until this succeeds, nothing is uploaded or downloaded, so a failure is
  // retried (every 15s) rather than leaving images unsaved for the visit.
  var syncFiles = function () {
    fetchWithin(30000, FILES_API, { cache: "no-store" })
      .then(function (res) {
        if (!apiOk(res)) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (ids) {
        listFailed = false;
        onServer = onServer || {};
        ids.forEach(function (id) {
          onServer[id] = 1;
        });
        fetchMissingFiles();
      })
      .catch(function (e) {
        listFailed = true;
        console.error("[server-sync] couldn't list images", e);
      })
      .then(showStatus);
  };

  // Every 2s: for the board's images the server doesn't have, make sure each
  // is saved on this device, and upload them one at a time.
  var uploading = false;
  var storeRetryAt = 0;
  var pushFiles = function () {
    if (uploading) return;
    var ids = imageFileIds().filter(function (id) {
      return !(onServer && onServer[id]);
    });
    if (!ids.length) {
      notUploaded = {};
      unstoredSince = {};
      missingSince = {};
      showStatus();
      return;
    }
    uploading = true;
    readFiles(ids, function (stored) {
      var now = Date.now();
      var files = {};
      var toStore = {};
      var wasUnstored = unstoredSince;
      var wasMissing = missingSince;
      notUploaded = {};
      unstoredSince = {};
      missingSince = {};
      ids.forEach(function (id) {
        var inTab = memFiles[id] && memFiles[id].dataURL ? memFiles[id] : null;
        var file = stored[id] || inTab;
        if (!file) {
          missingSince[id] = wasMissing[id] || now;
          return;
        }
        files[id] = file;
        notUploaded[id] = 1;
        if (!stored[id]) {
          unstoredSince[id] = wasUnstored[id] || now;
          if (now - unstoredSince[id] > STORE_GRACE_MS) toStore[id] = inTab;
        }
      });

      // 1. The editor's save to this device failed (it doesn't retry). Retry.
      if (Object.keys(toStore).length && now >= storeRetryAt) {
        storeRetryAt = now + 15000;
        storeFiles(
          toStore,
          function (err) {
            localSaveFailed = !!err;
            if (!err) {
              Object.keys(toStore).forEach(function (id) {
                delete unstoredSince[id];
              });
            }
            showStatus();
          },
          true,
        );
      }

      // 2. Upload, once the server's list is known.
      var queue = onServer
        ? Object.keys(files).filter(function (id) {
            return !(retryAt[id] > now);
          })
        : [];
      showStatus();
      var next = function () {
        var id = queue.shift();
        if (!id) {
          uploading = false;
          showStatus();
          return;
        }
        var failed = function (why) {
          retryAt[id] = Date.now() + 30000;
          console.error("[server-sync] image upload failed", id, why);
        };
        fetchWithin(180000, FILES_API + "/" + id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mimeType: files[id].mimeType, dataURL: files[id].dataURL }),
        })
          .then(function (res) {
            if (apiOk(res)) {
              onServer[id] = 1;
              delete notUploaded[id];
              delete unstoredSince[id];
              delete retryAt[id];
              if (!Object.keys(notUploaded).length) savedUntil = Date.now() + 3000;
            } else {
              failed(res.redirected ? "redirected to " + res.url : res.status);
            }
          })
          .catch(failed)
          .then(function () {
            // 3. Say how it's going.
            showStatus();
            next();
          });
      };
      next();
    });
  };

  // 1. Before boot: take the server copy if it is newer than what's local.
  var boardName = null;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", API, false);
    xhr.send();
    if (xhr.status === 404) {
      location.replace("/?missing=" + BOARD);
      return;
    }
    if (xhr.status === 200) {
      var scene = JSON.parse(xhr.responseText);
      boardName = scene.name;
      if (scene.files && Object.keys(scene.files).length) storeFiles(scene.files);
      if (localVersion() <= serverVersion) {
        // nothing unsaved here: the server's copy has everything
        applyServerScene(scene);
      } else {
        // edits made here that never reached the server: keep them; the
        // first push merges them, and its answer brings the server's side
        knownRev = -1;
      }
    }
  } catch (e) {
    console.error("[server-sync] initial load failed", e);
  }
  syncFiles();

  // The open scene including deleted elements, when the app is up: local
  // storage only keeps the others, and the server merges, so an element that
  // is simply missing would never be deleted there.
  var currentElements = function () {
    if (window.wbGetElements) {
      try {
        return window.wbGetElements();
      } catch (e) {
        console.error("[server-sync] couldn't read the scene", e);
      }
    }
    return JSON.parse(get("excalidraw") || "[]");
  };

  var buildPayload = function () {
    return JSON.stringify({
      savedAt: localVersion(),
      elements: currentElements(),
      appState: JSON.parse(get("excalidraw-state") || "{}"),
    });
  };

  var hasImages = function (elements) {
    return (elements || []).some(function (el) {
      return el.type === "image" && el.fileId && !el.isDeleted;
    });
  };

  // Brings the server's version of the board into the open scene.
  var applyRemote = function (scene) {
    if (!scene || !Array.isArray(scene.elements)) return;
    if (window.wbMergeRemote) {
      try {
        window.wbMergeRemote(scene.elements);
      } catch (e) {
        console.error("[server-sync] couldn't merge the server's changes", e);
        return;
      }
      if (typeof scene.rev === "number") knownRev = Math.max(knownRev, scene.rev);
    } else if (localVersion() <= serverVersion) {
      // the app isn't up yet: replace the local copy, which it reads on focus
      applyServerScene(scene);
      window.dispatchEvent(new Event("focus"));
    } else {
      return; // try again on the next round
    }
    if (hasImages(scene.elements)) syncFiles();
  };

  // 2. Push local changes. Excalidraw bumps version-dataState on every save.
  // The server merges them and answers with the board if it has elements
  // this tab doesn't.
  var pushing = false;
  var push = function () {
    var v = localVersion();
    if (pushing || v <= serverVersion) return;
    pushing = true;
    fetch(API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: buildPayload() })
      .then(function (res) {
        if (!apiOk(res)) {
          console.error("[server-sync] save failed", res.redirected ? "redirected to " + res.url : res.status);
          return;
        }
        setServerVersion(v);
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (reply) {
            if (!reply) return;
            if (reply.board) applyRemote(reply.board);
            else if (typeof reply.rev === "number" && knownRev >= 0) knownRev = Math.max(knownRev, reply.rev);
          });
      })
      .catch(function (e) {
        console.error("[server-sync] save failed", e);
      })
      .then(function () {
        pushing = false;
      });
  };

  // 3. Pull changes made elsewhere (Claude, another device): a cheap check
  // of the board's revision, then the board when it moved on.
  var pulling = false;
  var pull = function () {
    if (pulling || document.hidden) return;
    pulling = true;
    fetch(API + "/head", { cache: "no-store" })
      .then(function (res) {
        return apiOk(res) ? res.json() : null;
      })
      .then(function (head) {
        if (head) noteClaude(head.claude);
        if (!head || head.rev <= knownRev) return;
        return fetch(API, { cache: "no-store" })
          .then(function (res) {
            return apiOk(res) ? res.json() : null;
          })
          .then(applyRemote);
      })
      .catch(function () {})
      .then(function () {
        pulling = false;
      });
  };

  var flush = function () {
    // let Excalidraw flush its pending save to localStorage first
    setTimeout(function () {
      if (localVersion() > serverVersion) {
        navigator.sendBeacon(API, new Blob([buildPayload()], { type: "application/json" }));
      }
    }, 0);
  };

  setInterval(function () {
    push();
    pull();
    pushFiles();
    retryDownloadsIfDue();
    showClaude();
  }, 2000);
  setInterval(function () {
    if ((waitingForServer || listFailed) && !document.hidden) syncFiles();
  }, 15000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return flush();
    pull();
    // downloads may have been cut off while the page was in the background
    Object.keys(downloadRetryAt).forEach(function (id) {
      downloadRetryAt[id] = 0;
    });
    retryDownloadsIfDue();
  });
  window.addEventListener("pagehide", flush);
  // closing the tab now could lose the only copy of an image
  window.addEventListener("beforeunload", function (event) {
    if (!Object.keys(notUploaded).length) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // 4. "All boards" button and board name in the tab title.
  var addBackButton = function () {
    var style = document.createElement("style");
    style.textContent =
      "#wb-back{position:fixed;z-index:10;top:16px;left:60px;height:36px;display:flex;align-items:center;gap:6px;" +
      "padding:0 12px;border-radius:8px;font:500 14px/1 system-ui,sans-serif;text-decoration:none;" +
      "background:#ececf4;color:#1b1b1f;box-shadow:0 0 0 1px #e0e0ea}" +
      "#wb-back:hover{background:#e0dfff}" +
      ".excalidraw.theme--dark ~ #wb-back,html.wb-dark #wb-back{background:#232329;color:#e3e3e8;box-shadow:0 0 0 1px #2e2d39}" +
      "@media (max-width:730px){#wb-back{top:auto;bottom:72px;left:12px}}" +
      "#wb-messages{position:fixed;z-index:10;top:72px;left:50%;transform:translateX(-50%);display:flex;" +
      "flex-direction:column;align-items:center;gap:8px;width:max-content;max-width:min(92vw,560px);pointer-events:none}" +
      ".wb-msg{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:5px 5px 5px 12px;border-radius:8px;" +
      "font:500 13px/1.3 system-ui,sans-serif;background:#ececf4;color:#1b1b1f;box-shadow:0 0 0 1px #e0e0ea}" +
      "html.wb-dark .wb-msg{background:#232329;color:#e3e3e8;box-shadow:0 0 0 1px #2e2d39}" +
      ".wb-msg.wb-warn{background:#fff4d6;color:#5c3d00;box-shadow:0 0 0 1px #f0c24b}" +
      "html.wb-dark .wb-msg.wb-warn{background:#3d2f0d;color:#ffe2a0;box-shadow:0 0 0 1px #7a5c14}" +
      ".wb-msg.wb-claude{background:#e0dfff;color:#2b2a6b;box-shadow:0 0 0 1px #c3c1ff}" +
      "html.wb-dark .wb-msg.wb-claude{background:#2e2c5a;color:#e0dfff;box-shadow:0 0 0 1px #4a47a3}" +
      ".wb-msg.wb-claude::before{content:'';flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;" +
      "animation:wb-pulse 1.4s ease-in-out infinite}" +
      "@keyframes wb-pulse{50%{opacity:.25}}" +
      "@media (prefers-reduced-motion:reduce){.wb-msg.wb-claude::before{animation:none}}" +
      ".wb-msg-text{flex:1;min-width:0}" +
      ".wb-msg-close{flex:none;display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;" +
      "background:transparent;color:inherit;opacity:.6;cursor:pointer}" +
      ".wb-msg-close:hover{opacity:1;background:rgba(0,0,0,.08)}" +
      "html.wb-dark .wb-msg-close:hover{background:rgba(255,255,255,.1)}" +
      ".wb-msg-close:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:1px}" +
      "@media (max-width:730px){#wb-messages{top:24px}}";
    document.head.appendChild(style);
    var a = document.createElement("a");
    a.id = "wb-back";
    a.href = "/";
    a.title = "All boards";
    a.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
      "<span></span>";
    a.querySelector("span").textContent = boardName || "Boards";
    document.body.appendChild(a);
    boxEl = document.createElement("div");
    boxEl.id = "wb-messages";
    boxEl.setAttribute("role", "status");
    document.body.appendChild(boxEl);
    showStatus();
    // follow Excalidraw's theme
    var sync = function () {
      var dark = document.querySelector(".excalidraw.theme--dark");
      document.documentElement.classList.toggle("wb-dark", !!dark);
    };
    new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    sync();
  };
  if (document.body) addBackButton();
  else document.addEventListener("DOMContentLoaded", addBackButton);

  if (boardName) {
    var setTitle = function () {
      var t = boardName + " · Whiteboard";
      if (document.title !== t) document.title = t;
    };
    setTitle();
    new MutationObserver(setTitle).observe(document.querySelector("title") || document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
})();
