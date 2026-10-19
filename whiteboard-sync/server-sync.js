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
  // Put any missing ones into Excalidraw's image store (IndexedDB "files-db",
  // same layout as idb-keyval's createStore), then have it reload images.
  var storeFiles = function (files) {
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
        var check = store.getKey(id);
        check.onsuccess = function () {
          if (check.result === undefined) {
            store.put(files[id], id);
            added++;
          }
        };
      });
      tx.oncomplete = function () {
        db.close();
        if (added) {
          rawSet.call(localStorage, "version-files", JSON.stringify(Date.now()));
          window.dispatchEvent(new Event("focus"));
          // again later, in case Excalidraw wasn't listening yet
          setTimeout(function () {
            window.dispatchEvent(new Event("focus"));
          }, 2000);
        }
      };
    };
    req.onerror = function () {
      console.error("[server-sync] couldn't store images", req.error);
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
    };
    req.onerror = function () {
      console.error("[server-sync] couldn't read images", req.error);
      cb({});
    };
  };

  var imageFileIds = function () {
    var ids = {};
    try {
      JSON.parse(get("excalidraw") || "[]").forEach(function (el) {
        if (el.type === "image" && el.fileId && !el.isDeleted) ids[el.fileId] = 1;
      });
    } catch (e) {}
    return Object.keys(ids);
  };

  // Image files are stored on the server (in a GitHub repo) by fileId, shared
  // by all boards. `onServer` is null until the server's list is known, and
  // stays null if image storage isn't set up there.
  var FILES_API = "/api/files";
  var onServer = null;
  var retryAt = {};

  // Put images the board needs, but this browser doesn't have, into the store.
  var fetchMissingFiles = function () {
    var ids = imageFileIds().filter(function (id) {
      return onServer && onServer[id];
    });
    if (!ids.length) return;
    readFiles(ids, function (have) {
      var missing = ids.filter(function (id) {
        return !have[id];
      });
      Promise.all(
        missing.map(function (id) {
          return fetch(FILES_API + "/" + id)
            .then(function (res) {
              return res.ok ? res.json() : null;
            })
            .catch(function () {
              return null;
            });
        }),
      ).then(function (list) {
        var files = {};
        list.forEach(function (file) {
          if (file) files[file.id] = file;
        });
        if (Object.keys(files).length) storeFiles(files);
      });
    });
  };

  var syncFiles = function () {
    fetch(FILES_API, { cache: "no-store" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (ids) {
        if (!ids) return;
        onServer = onServer || {};
        ids.forEach(function (id) {
          onServer[id] = 1;
        });
        fetchMissingFiles();
      })
      .catch(function (e) {
        console.error("[server-sync] couldn't list images", e);
      });
  };

  // Upload images on the board that the server doesn't have yet, one at a time.
  var uploading = false;
  var pushFiles = function () {
    if (!onServer || uploading) return;
    var now = Date.now();
    var ids = imageFileIds().filter(function (id) {
      return !onServer[id] && !(retryAt[id] > now);
    });
    if (!ids.length) return;
    uploading = true;
    // images not in the store yet (still being added) are picked up next time
    readFiles(ids, function (files) {
      var queue = Object.keys(files);
      var next = function () {
        var id = queue.shift();
        if (!id) {
          uploading = false;
          return;
        }
        fetch(FILES_API + "/" + id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mimeType: files[id].mimeType, dataURL: files[id].dataURL }),
        })
          .then(function (res) {
            if (res.ok) {
              onServer[id] = 1;
            } else {
              retryAt[id] = Date.now() + 60000;
              console.error("[server-sync] image upload failed", id, res.status);
            }
          })
          .catch(function (e) {
            retryAt[id] = Date.now() + 60000;
            console.error("[server-sync] image upload failed", id, e);
          })
          .then(next);
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
        if (res.ok) {
          setServerVersion(v);
        } else if (res.status === 409) {
          // another device saved something newer; take it
          return res.json().then(function (scene) {
            applyServerScene(scene);
            window.dispatchEvent(new Event("focus"));
            syncFiles();
          });
        } else {
          console.error("[server-sync] save failed", res.status);
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
        return res.status === 200 ? res.json() : null;
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
  }, 2000);
  setInterval(pull, 15000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) flush();
    else pull();
  });
  window.addEventListener("pagehide", flush);

  // 4. "All boards" button and board name in the tab title.
  var addBackButton = function () {
    var style = document.createElement("style");
    style.textContent =
      "#wb-back{position:fixed;z-index:10;top:16px;left:60px;height:36px;display:flex;align-items:center;gap:6px;" +
      "padding:0 12px;border-radius:8px;font:500 14px/1 system-ui,sans-serif;text-decoration:none;" +
      "background:#ececf4;color:#1b1b1f;box-shadow:0 0 0 1px #e0e0ea}" +
      "#wb-back:hover{background:#e0dfff}" +
      ".excalidraw.theme--dark ~ #wb-back,html.wb-dark #wb-back{background:#232329;color:#e3e3e8;box-shadow:0 0 0 1px #2e2d39}" +
      "@media (max-width:730px){#wb-back{top:auto;bottom:72px;left:12px}}";
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
