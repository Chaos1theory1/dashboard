(function () {
  "use strict";

  const SUPABASE_URL =
    "https://ikomtseunfwffcghnifr.supabase.co";

  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_9rFYPKIZmlh83tMr4aVfHQ_wnbGM63N";

  const MB = 1024 * 1024;

  const PROFILES = {
    petri: {
      maxDimension: 2560
    },

    lc: {
      maxDimension: 2048
    },

    grain: {
      maxDimension: 2048
    }
  };

  if (!window.supabase) {
    console.error(
      "Supabase JS n'est pas chargé."
    );
    return;
  }

  const supabaseClient =
    window.supabase.createClient(
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

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options
    });

    const text = await response.text();

    let result = null;

    try {
      result = text
        ? JSON.parse(text)
        : {};
    } catch (_) {
      result = null;
    }

    if (!response.ok) {
      throw new Error(
        result?.error ||
        result?.message ||
        text ||
        `HTTP ${response.status}`
      );
    }

    return result || {};
  }

  async function preprocessLabImage(
    file,
    kind
  ) {
    if (!file) {
      throw new Error(
        "Aucune image sélectionnée."
      );
    }

    if (
      !String(file.type || "")
        .startsWith("image/")
    ) {
      throw new Error(
        "Le fichier sélectionné n'est pas une image."
      );
    }

    const profile = PROFILES[kind];

    if (!profile) {
      throw new Error(
        "Type image invalide."
      );
    }

    const mime =
      String(file.type || "")
        .toLowerCase();

    /*
     * Ne pas essayer de décoder HEIC/HEIF
     * dans le navigateur.
     */
    if (
      mime === "image/heic" ||
      mime === "image/heif"
    ) {
      return file;
    }

    let bitmap;

    try {
      bitmap =
        await createImageBitmap(file, {
          imageOrientation:
            "from-image"
        });
    } catch (e) {
      console.warn(
        "Prétraitement navigateur impossible:",
        e
      );

      return file;
    }

    const originalWidth =
      bitmap.width;

    const originalHeight =
      bitmap.height;

    const maxOriginal =
      Math.max(
        originalWidth,
        originalHeight
      );

    const scale =
      Math.min(
        1,
        profile.maxDimension /
          maxOriginal
      );

    /*
     * Petite image : inutile de la
     * recomprimer avant Edge Function.
     */
    if (
      scale === 1 &&
      file.size <= 2 * MB
    ) {
      bitmap.close();
      return file;
    }

    const width =
      Math.max(
        1,
        Math.round(
          originalWidth * scale
        )
      );

    const height =
      Math.max(
        1,
        Math.round(
          originalHeight * scale
        )
      );

    const canvas =
      document.createElement(
        "canvas"
      );

    canvas.width = width;
    canvas.height = height;

    const ctx =
      canvas.getContext("2d", {
        alpha: false
      });

    if (!ctx) {
      bitmap.close();
      return file;
    }

    ctx.fillStyle = "#ffffff";

    ctx.fillRect(
      0,
      0,
      width,
      height
    );

    ctx.drawImage(
      bitmap,
      0,
      0,
      width,
      height
    );

    bitmap.close();

    const blob =
      await new Promise(
        resolve => {
          canvas.toBlob(
            resolve,
            "image/webp",
            0.86
          );
        }
      );

    if (!blob) {
      return file;
    }

    const baseName =
      String(
        file.name ||
        "photo"
      ).replace(
        /\.[^.]+$/,
        ""
      );

    return new File(
      [blob],
      baseName + ".webp",
      {
        type: "image/webp",
        lastModified:
          Date.now()
      }
    );
  }

  async function uploadLabImage(
    file,
    kind,
    onStatus
  ) {
    const status =
      typeof onStatus ===
      "function"
        ? onStatus
        : () => {};

    if (!PROFILES[kind]) {
      throw new Error(
        "Type invalide : " +
        kind
      );
    }

    status(
      "Préparation de la photo..."
    );

    const preparedFile =
      await preprocessLabImage(
        file,
        kind
      );

    console.log(
      "Original:",
      Math.round(
        file.size / 1024
      ),
      "KB"
    );

    console.log(
      "Temporaire:",
      Math.round(
        preparedFile.size /
          1024
      ),
      "KB"
    );

    /*
     * Protection Edge Function.
     */
    if (
      preparedFile.size >
      10 * MB
    ) {
      throw new Error(
        "L'image reste trop volumineuse après préparation."
      );
    }

    /*
     * A. Demander une URL/token
     * signé au backend.
     */
    status(
      "Création upload sécurisé..."
    );

    const signed =
      await fetchJson(
        "/api/media/sign-upload",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
            Accept:
              "application/json"
          },

          body:
            JSON.stringify({
              kind,
              filename:
                preparedFile.name,
              contentType:
                preparedFile.type,
              size:
                preparedFile.size
            })
        }
      );

    if (
      !signed.path ||
      !signed.token
    ) {
      throw new Error(
        "Token Supabase manquant."
      );
    }

    /*
     * B. Browser -> Supabase.
     * Le fichier NE passe PAS par Vercel.
     */
    status(
      "Upload temporaire..."
    );

    const uploadResult =
      await supabaseClient
        .storage
        .from(
          signed.bucket ||
          "incoming-media"
        )
        .uploadToSignedUrl(
          signed.path,
          signed.token,
          preparedFile,
          {
            contentType:
              preparedFile.type
          }
        );

    if (
      uploadResult.error
    ) {
      throw new Error(
        "Upload Supabase : " +
        uploadResult.error
          .message
      );
    }

    /*
     * C. Demander conversion AVIF.
     */
    status(
      "Conversion en AVIF..."
    );

    const processed =
      await fetchJson(
        "/api/media/process",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
            Accept:
              "application/json"
          },

          body:
            JSON.stringify({
              kind,
              sourcePath:
                signed.path
            })
        }
      );

    if (
      !processed.file_url
    ) {
      throw new Error(
        "La conversion n'a pas retourné file_url."
      );
    }

    status(
      "Photo optimisée ✓"
    );

    console.log(
      "AVIF final:",
      processed.file_url
    );

    return processed;
  }

  window.uploadLabImage =
    uploadLabImage;

})();