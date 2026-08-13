async function resizeImageBeforeUpload(
  file,
  maxDimension = 2560
) {

  if (
    ![
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(file.type)
  ) {
    return file;
  }

  const bitmap =
    await createImageBitmap(file);

  let width = bitmap.width;
  let height = bitmap.height;

  if (
    width <= maxDimension &&
    height <= maxDimension
  ) {
    bitmap.close();
    return file;
  }

  const ratio =
    Math.min(
      maxDimension / width,
      maxDimension / height
    );

  width =
    Math.round(width * ratio);

  height =
    Math.round(height * ratio);

  const canvas =
    document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d");

  ctx.drawImage(
    bitmap,
    0,
    0,
    width,
    height
  );

  bitmap.close();

  const blob =
    await new Promise(resolve =>
      canvas.toBlob(
        resolve,
        "image/jpeg",
        0.85
      )
    );

  if (!blob) return file;

  return new File(
    [blob],
    "upload.jpg",
    {
      type: "image/jpeg"
    }
  );
}