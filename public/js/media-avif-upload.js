(function () {
  "use strict";

  console.log("🔄 Initialisation module AVIF...");

  // ============================================================
  // MYCELIUM TECH DIGITAL - shared photo pipeline
  //
  // Phone / PC photo
  //   -> browser resize + compression
  //   -> signed direct upload to Supabase incoming-media
  //   -> Vercel Node + Sharp AVIF conversion
  //   -> final public bucket
  //   -> temporary source deleted by backend
  //
  // Important: the binary image is NOT uploaded through Vercel.
  // ============================================================

  const SUPABASE_URL = "https://ikomtseunfwffcghnifr.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9rFYPKIZmlh83tMr4aVfHQ_wnbGM63N";

  const MB = 1024 * 1024;

  // The browser aims to keep the temporary upload comfortably below
  // normal storage/request limits. This is not a user-facing camera limit:
  // large phone photos are automatically reduced before upload.
  const TARGET_TEMP_BYTES = 4 * MB;
  const EMERGENCY_TEMP_BYTES = 40 * MB;

  const PROFILES = {
    petri: { maxDimension: 2560 },
    lc: { maxDimension: 2048 },
    grain: { maxDimension: 2048 }
  };

  let supabaseClient = null;

  function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function emitStatus(callback, message, percent, stage, extra) {
    const p = clampPercent(percent);
    const text = `${message} ${p}%`;

    if (typeof callback === "function") {
      callback(text, p, {
        stage: stage || "",
        message,
        percent: p,
        ...(extra || {})
      });
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function renderLabUploadProgress(container, message, percent) {
    if (!container) return;
    const p = clampPercent(percent);
    container.innerHTML = `
      <div style="width:100%;max-width:420px;margin:8px auto;text-align:left;">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:7px;font-size:12px;font-weight:800;color:#555;">
          <span>${escapeHtml(message || "Traitement de la photo...")}</span>
          <span style="white-space:nowrap;">${p}%</span>
        </div>
        <div style="height:12px;background:#e7e7e7;border-radius:999px;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.08);">
          <div style="height:100%;width:${p}%;background:#2fa35a;border-radius:999px;transition:width .18s ease;"></div>
        </div>
      </div>`;
  }

  function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;

    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("Bibliothèque Supabase JS non chargée");
    }

    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );

    return supabaseClient;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...(options || {})
    });

    const raw = await response.text();
    let data = {};

    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = null;
      }
    }

    if (!response.ok) {
      if (data && data.error) throw new Error(data.error);
      if (data && data.message) throw new Error(data.message);
      throw new Error(raw || response.statusText || "HTTP " + response.status);
    }

    return data || {};
  }

  function fileBaseName(file) {
    return String((file && file.name) || "photo").replace(/\.[^.]+$/, "");
  }

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();

      image.onload = function () {
        resolve({
          source: image,
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
          close: function () {
            URL.revokeObjectURL(objectUrl);
          }
        });
      };

      image.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Décodage image navigateur impossible"));
      };

      image.src = objectUrl;
    });
  }

  async function decodeBrowserImage(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, {
          imageOrientation: "from-image"
        });

        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: function () {
            try { bitmap.close(); } catch (_) {}
          }
        };
      } catch (error) {
        console.warn("createImageBitmap indisponible pour cette photo, fallback <img>.", error);
      }
    }

    return loadImageElement(file);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, type, quality);
    });
  }

  async function encodeWebp(source, width, height, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    let blob = await canvasToBlob(canvas, "image/webp", quality);
    if (!blob) blob = await canvasToBlob(canvas, "image/jpeg", quality);
    return blob;
  }

  async function preprocessLabImage(file, kind, onProgress) {
    if (!file) throw new Error("Aucune photo sélectionnée.");

    const mime = String(file.type || "").toLowerCase();
    if (mime && !mime.startsWith("image/")) {
      throw new Error("Le fichier sélectionné n'est pas une image.");
    }

    const profile = PROFILES[kind];
    if (!profile) throw new Error("Type média invalide : " + kind);

    if (typeof onProgress === "function") onProgress(2, "Lecture de la photo...");

    let decoded;
    try {
      decoded = await decodeBrowserImage(file);
    } catch (error) {
      // Very uncommon fallback (for a browser that cannot decode the selected format).
      // We still allow the backend to try the original instead of rejecting an ordinary photo.
      console.warn("⚠️ Prétraitement navigateur impossible. Original conservé.", error);
      if (typeof onProgress === "function") onProgress(16, "Photo conservée pour traitement serveur...");
      return file;
    }

    try {
      const originalWidth = Number(decoded.width || 0);
      const originalHeight = Number(decoded.height || 0);
      const largestDimension = Math.max(originalWidth, originalHeight);

      if (!largestDimension) {
        console.warn("Dimensions image inconnues. Original conservé.");
        return file;
      }

      let scale = Math.min(1, profile.maxDimension / largestDimension);
      let outputWidth = Math.max(1, Math.round(originalWidth * scale));
      let outputHeight = Math.max(1, Math.round(originalHeight * scale));

      const isHeic = mime === "image/heic" || mime === "image/heif";
      const shouldTranscode =
        isHeic ||
        scale < 1 ||
        file.size > 2 * MB ||
        !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mime);

      if (!shouldTranscode) {
        console.log("ℹ️ Image déjà suffisamment petite.");
        if (typeof onProgress === "function") onProgress(18, "Photo prête...");
        return file;
      }

      console.log(
        "📐 Préparation navigateur:",
        `${originalWidth}x${originalHeight}`,
        "→",
        `${outputWidth}x${outputHeight}`
      );

      if (typeof onProgress === "function") onProgress(7, "Redimensionnement de la photo...");

      // Adaptive compression: ordinary phone photos are silently reduced until
      // the temporary upload is small and reliable. No 5 MB rejection is shown.
      const qualities = [0.88, 0.82, 0.76, 0.70, 0.64, 0.58];
      let blob = null;
      let shrinkPass = 0;

      while (shrinkPass < 4) {
        for (let i = 0; i < qualities.length; i += 1) {
          const quality = qualities[i];
          blob = await encodeWebp(decoded.source, outputWidth, outputHeight, quality);
          if (!blob) continue;

          const localProgress = 8 + Math.min(8, shrinkPass * 2 + Math.floor((i + 1) / 2));
          if (typeof onProgress === "function") {
            onProgress(localProgress, "Compression automatique de la photo...");
          }

          if (blob.size <= TARGET_TEMP_BYTES) break;
        }

        if (blob && blob.size <= TARGET_TEMP_BYTES) break;

        // Still unusually large: reduce dimensions a little more and retry.
        outputWidth = Math.max(1, Math.round(outputWidth * 0.82));
        outputHeight = Math.max(1, Math.round(outputHeight * 0.82));
        shrinkPass += 1;
      }

      if (!blob) {
        console.warn("Compression WebP navigateur impossible. Original conservé.");
        return file;
      }

      const preparedType = blob.type === "image/jpeg" ? "image/jpeg" : "image/webp";
      const preparedExt = preparedType === "image/jpeg" ? ".jpg" : ".webp";
      const prepared = new File([blob], fileBaseName(file) + preparedExt, {
        type: preparedType,
        lastModified: Date.now()
      });

      console.log(
        "📦 Photo navigateur:",
        Math.round(file.size / 1024),
        "KB →",
        Math.round(prepared.size / 1024),
        "KB"
      );

      if (typeof onProgress === "function") onProgress(18, "Photo prête pour l'envoi...");
      return prepared;
    } finally {
      if (decoded && typeof decoded.close === "function") decoded.close();
    }
  }

  function buildSignedUploadUrl(signed, bucket) {
    if (signed && signed.signedUrl) return String(signed.signedUrl);

    const cleanPath = String((signed && signed.path) || "")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");

    return (
      SUPABASE_URL.replace(/\/$/, "") +
      "/storage/v1/object/upload/sign/" +
      encodeURIComponent(bucket) +
      "/" +
      cleanPath +
      "?token=" +
      encodeURIComponent(String((signed && signed.token) || ""))
    );
  }

  function uploadSignedUrlWithProgress(signedUrl, file, onProgress) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signedUrl, true);
      xhr.responseType = "text";

      // Matches Supabase Storage signed-upload behavior. The new
      // sb_publishable_ key belongs in the apikey header, not Bearer auth.
      xhr.setRequestHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
      xhr.setRequestHeader("x-upsert", "false");

      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        const ratio = event.total > 0 ? event.loaded / event.total : 0;
        if (typeof onProgress === "function") onProgress(ratio);
      };

      xhr.onerror = function () {
        reject(new Error("Connexion interrompue pendant l'envoi de la photo."));
      };

      xhr.onabort = function () {
        reject(new Error("Envoi de la photo annulé."));
      };

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (typeof onProgress === "function") onProgress(1);
          resolve(xhr.responseText || "");
          return;
        }

        let message = xhr.responseText || xhr.statusText || `HTTP ${xhr.status}`;
        try {
          const parsed = JSON.parse(message);
          message = parsed.message || parsed.error || message;
        } catch (_) {}

        reject(new Error("Upload Supabase impossible : " + message));
      };

      const body = new FormData();
      body.append("cacheControl", "3600");
      body.append("", file);
      xhr.send(body);
    });
  }

  async function uploadLabImage(file, kind, onStatus, metadata) {
    metadata = metadata && typeof metadata === "object" ? metadata : {};

    if (!PROFILES[kind]) throw new Error("Type image invalide : " + kind);

    emitStatus(onStatus, "Préparation de la photo...", 2, "prepare");

    const preparedFile = await preprocessLabImage(file, kind, function (p, message) {
      emitStatus(onStatus, message || "Préparation de la photo...", p, "prepare");
    });

    // This is only an emergency safeguard. Normal phone photos are automatically
    // reduced by the browser and should be far below this value.
    if (preparedFile.size > EMERGENCY_TEMP_BYTES) {
      throw new Error(
        "Cette photo est exceptionnellement volumineuse et n'a pas pu être réduite automatiquement."
      );
    }

    emitStatus(onStatus, "Création de l'envoi sécurisé...", 20, "sign");

    const signed = await fetchJson("/api/media/sign-upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        kind,
        filename: preparedFile.name || file.name || "photo.jpg",
        contentType: preparedFile.type || file.type || "application/octet-stream",
        size: preparedFile.size,
        entityId: metadata.entityId || null
      })
    });

    if (!signed.path) throw new Error("Chemin upload Supabase manquant.");
    if (!signed.token) throw new Error("Token upload Supabase manquant.");

    // Instantiate once so the page still verifies that Supabase JS is loaded.
    getSupabaseClient();

    const bucket = signed.bucket || "incoming-media";
    const signedUrl = buildSignedUploadUrl(signed, bucket);

    emitStatus(onStatus, "Envoi de la photo...", 21, "upload");

    await uploadSignedUrlWithProgress(signedUrl, preparedFile, function (ratio) {
      // Real byte progress occupies 21 -> 80 of the global progress bar.
      const overall = 21 + ratio * 59;
      emitStatus(onStatus, "Envoi de la photo...", overall, "upload", {
        uploadedRatio: ratio
      });
    });

    console.log("✅ Upload temporaire:", bucket + "/" + signed.path);

    emitStatus(onStatus, "Photo envoyée. Optimisation AVIF...", 84, "process");

    const processed = await fetchJson("/api/media/process", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        kind,
        sourcePath: signed.path,
        entityId: metadata.entityId || null
      })
    });

    if (!processed.file_url) {
      throw new Error("Conversion AVIF terminée sans file_url.");
    }

    if (!/\.avif(?:$|\?)/i.test(processed.file_url)) {
      console.warn("⚠️ L'URL finale ne se termine pas par .avif:", processed.file_url);
    }

    emitStatus(onStatus, "Photo optimisée et enregistrée ✓", 100, "done");

    console.log("✅ AVIF final:", processed.file_url);

    return {
      ...processed,
      original_size: file.size,
      temporary_size: preparedFile.size
    };
  }

  window.preprocessLabImage = preprocessLabImage;
  window.uploadLabImage = uploadLabImage;
  window.renderLabUploadProgress = renderLabUploadProgress;

  console.log("✅ Module AVIF prêt - uploadLabImage disponible");
})();
