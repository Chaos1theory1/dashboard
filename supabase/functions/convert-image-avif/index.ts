import { createClient } from "npm:@supabase/supabase-js@2";
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
} from "npm:@imagemagick/magick-wasm@^0";

const wasmBytes = await Deno.readFile(
  new URL(
    "magick.wasm",
    import.meta.resolve("npm:@imagemagick/magick-wasm@^0")
  )
);

await initializeImageMagick(wasmBytes);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MEDIA_PIPELINE_SECRET =
  Deno.env.get("MEDIA_PIPELINE_SECRET")!;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

const PROFILES = {
  petri: {
    bucket: "isolements",
    prefix: "ISOIMG",
    maxDimension: 2560,
    quality: 68,
  },

  lc: {
    bucket: "lc",
    prefix: "LCIMG",
    maxDimension: 2048,
    quality: 64,
  },

  grain: {
    bucket: "grain",
    prefix: "GRAINIMG",
    maxDimension: 2048,
    quality: 64,
  },
};

function createFilename(prefix: string) {
  const now = new Date();

  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);

  const random = crypto.randomUUID().slice(0, 8);

  return `${prefix}-${stamp}-${random}.avif`;
}

Deno.serve(async (req) => {
  try {
    if (
      req.headers.get("x-media-secret") !==
      MEDIA_PIPELINE_SECRET
    ) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json();

    const sourcePath = String(body.sourcePath || "");
    const kind = String(body.kind || "");

    const profile =
      PROFILES[kind as keyof typeof PROFILES];

    if (!profile) {
      return Response.json(
        { error: "Invalid media type" },
        { status: 400 }
      );
    }

    if (!sourcePath) {
      return Response.json(
        { error: "sourcePath required" },
        { status: 400 }
      );
    }

    const { data: sourceFile, error: downloadError } =
      await supabase.storage
        .from("incoming-media")
        .download(sourcePath);

    if (downloadError || !sourceFile) {
      throw downloadError ||
        new Error("Temporary image not found");
    }

    const sourceBytes = new Uint8Array(
      await sourceFile.arrayBuffer()
    );

    const avifBytes = ImageMagick.read(
      sourceBytes,
      (image): Uint8Array => {

        image.autoOrient();

        if (
          image.width > profile.maxDimension ||
          image.height > profile.maxDimension
        ) {
          if (image.width >= image.height) {
            image.resize(profile.maxDimension, 0);
          } else {
            image.resize(0, profile.maxDimension);
          }
        }

        image.quality = profile.quality;

        return image.write(
          MagickFormat.Avif,
          (data) => Uint8Array.from(data)
        );
      }
    );

    const finalName =
      createFilename(profile.prefix);

    const { error: uploadError } =
      await supabase.storage
        .from(profile.bucket)
        .upload(finalName, avifBytes, {
          contentType: "image/avif",
          cacheControl: "31536000",
          upsert: false,
        });

    if (uploadError) {
      throw uploadError;
    }

    const { data: publicData } =
      supabase.storage
        .from(profile.bucket)
        .getPublicUrl(finalName);

    await supabase.storage
      .from("incoming-media")
      .remove([sourcePath]);

    return Response.json({
      success: true,
      bucket: profile.bucket,
      filename: finalName,
      file_url: publicData.publicUrl,
    });

  } catch (error) {
    console.error(error);

    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      { status: 500 }
    );
  }
});