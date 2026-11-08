// Gives each board (/b/<id>) its own localStorage scene and mirrors it to the
// server (/api/boards/<id>). Loaded as a classic script before the Excalidraw
// bundle, so the board's server copy is in place by the time Excalidraw boots.
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

  var applyServerScene = function (scene) {
    set("excalidraw", JSON.stringify(scene.elements));
    set("excalidraw-state", JSON.stringify(scene.appState || {}));
    set("version-dataState", JSON.stringify(scene.savedAt));
    setServerVersion(scene.savedAt);
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
  var storeFiles = function (files, done) {
    var finish = function (err, added) {
      if (added) notifyExcalidraw();
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
  // images on this board that are in this browser but not on the server yet
  var notUploaded = {};
  // images on this board that are neither here nor on the server, with the
  // time each was first seen missing (a just-pasted image takes a moment to
  // reach the image store)
  var missingSince = {};
  var MISSING_GRACE_MS = 10000;

  // Lets the app's clean-up of old images keep the ones the server doesn't
  // have: they may be the only copy (LocalData.ts, clearObsoleteFiles).
  window.wbServerHasFile = function (id) {
    return !!(onServer && onServer[id]);
  };

  var plural = function (n) {
    return n + (n === 1 ? " image" : " images");
  };

  var statusEl = null;
  var showStatus = function () {
    if (!statusEl) return;
    var text = "";
    var warn = false;
    var now = Date.now();
    var missing = Object.keys(missingSince).filter(function (id) {
      return now - missingSince[id] > MISSING_GRACE_MS;
    }).length;
    var unsent = Object.keys(notUploaded);
    var failedUploads = unsent.filter(function (id) {
      return retryAt[id] > now;
    }).length;
    if (Object.keys(downloading).length) {
      text = "Loading images " + batchDone + "/" + Object.keys(batch).length;
    } else {
      batch = {};
      batchDone = 0;
      var failed = Object.keys(downloadRetryAt).length;
      if (failed) text = plural(failed) + " couldn't load. Retrying…";
    }
    if (!text && failedUploads) {
      text = plural(failedUploads) + " couldn't be saved to the server. Retrying… Keep this tab open.";
      warn = true;
    } else if (!text && unsent.length) {
      text = "Saving " + plural(unsent.length) + " to the server…";
    } else if (!text && listFailed) {
      text = "Can't reach image storage. Images added here aren't backed up yet. Retrying…";
      warn = true;
    }
    if (!text && missing) {
      text =
        plural(missing) +
        " never reached the server. Open this board on the device they were added on to upload them.";
      warn = true;
    }
    statusEl.textContent = text;
    statusEl.className = warn ? "wb-warn" : "";
    statusEl.style.display = text ? "" : "none";
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

  // Upload images on the board that the server doesn't have yet, one at a time.
  var uploading = false;
  var pushFiles = function () {
    if (!onServer || uploading) return;
    var ids = imageFileIds().filter(function (id) {
      return !onServer[id];
    });
    if (!ids.length) {
      notUploaded = {};
      missingSince = {};
      showStatus();
      return;
    }
    uploading = true;
    // images not in the store yet (still being added) are picked up next time
    readFiles(ids, function (files) {
      var now = Date.now();
      notUploaded = {};
      var stillMissing = {};
      ids.forEach(function (id) {
        if (files[id]) notUploaded[id] = 1;
        else stillMissing[id] = missingSince[id] || now;
      });
      missingSince = stillMissing;
      showStatus();
      var queue = Object.keys(files).filter(function (id) {
        return !(retryAt[id] > now);
      });
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
              delete retryAt[id];
            } else {
              failed(res.redirected ? "redirected to " + res.url : res.status);
            }
          })
          .catch(failed)
          .then(function () {
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
      if (scene.savedAt > localVersion()) {
        applyServerScene(scene);
      } else if (serverVersion < 0) {
        setServerVersion(scene.savedAt);
      }
    }
  } catch (e) {
    console.error("[server-sync] initial load failed", e);
  }
  syncFiles();

  var buildPayload = function () {
    return JSON.stringify({
      savedAt: localVersion(),
      elements: JSON.parse(get("excalidraw") || "[]"),
      appState: JSON.parse(get("excalidraw-state") || "{}"),
    });
  };

  // 2. Push local changes. Excalidraw bumps version-dataState on every save.
  var pushing = false;
  var push = function () {
    var v = localVersion();
    if (pushing || v <= serverVersion) return;
    pushing = true;
    fetch(API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: buildPayload() })
      .then(function (res) {
        if (apiOk(res)) {
          setServerVersion(v);
        } else if (res.status === 409) {
          // another device saved something newer; take it
          return res.json().then(function (scene) {
            applyServerScene(scene);
            window.dispatchEvent(new Event("focus"));
            syncFiles();
          });
        } else {
          console.error("[server-sync] save failed", res.redirected ? "redirected to " + res.url : res.status);
        }
      })
      .catch(function (e) {
        console.error("[server-sync] save failed", e);
      })
      .then(function () {
        pushing = false;
      });
  };

  // 3. Pull changes made on another device, but only when there are no
  // unpushed local edits. Excalidraw re-reads localStorage on window focus.
  var pull = function () {
    if (document.hidden || localVersion() > serverVersion) return;
    fetch(API, { cache: "no-store" })
      .then(function (res) {
        return res.status === 200 && !res.redirected ? res.json() : null;
      })
      .then(function (scene) {
        if (scene && scene.savedAt > localVersion()) {
          applyServerScene(scene);
          window.dispatchEvent(new Event("focus"));
          syncFiles();
        }
      })
      .catch(function () {});
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
    pushFiles();
    retryDownloadsIfDue();
  }, 2000);
  setInterval(function () {
    pull();
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
      "#wb-status{position:fixed;z-index:10;top:72px;left:50%;transform:translateX(-50%);padding:6px 12px;" +
      "border-radius:8px;font:500 13px/1.2 system-ui,sans-serif;white-space:nowrap;pointer-events:none;" +
      "background:#ececf4;color:#1b1b1f;box-shadow:0 0 0 1px #e0e0ea}" +
      "html.wb-dark #wb-status{background:#232329;color:#e3e3e8;box-shadow:0 0 0 1px #2e2d39}" +
      "#wb-status.wb-warn{background:#fff4d6;color:#5c3d00;box-shadow:0 0 0 1px #f0c24b;white-space:normal;max-width:min(90vw,520px);text-align:center}" +
      "html.wb-dark #wb-status.wb-warn{background:#3d2f0d;color:#ffe2a0;box-shadow:0 0 0 1px #7a5c14}" +
      "@media (max-width:730px){#wb-status{top:24px}}";
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
    statusEl = document.createElement("div");
    statusEl.id = "wb-status";
    statusEl.setAttribute("role", "status");
    document.body.appendChild(statusEl);
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
