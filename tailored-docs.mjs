// tailored-docs.mjs — build the two PDFs (tailored resume + cover letter) that ride along
// with every role email. Shared by the daily engine, the first-role-on-onboarding send, and
// the test send, so all three behave identically.
//
// Best-effort by contract: returns [{ filename, content (base64) }, ...] or [] on ANY failure
// (no resume on file, model hiccup, render error). A send must never break because the docs
// didn't build, so callers attach what they get and the email body only claims attachments
// when this actually returned some. Imports resume-pdf (react-pdf), so callers run under tsx.

import { buildTailoredDocs } from "./resume-build.mjs";
import { renderResumePdf, renderCoverPdf } from "./resume-pdf.js";

const clean = (v, fb) => (v || fb).replace(/[^\w.-]+/g, "_").slice(0, 40);

export async function buildEmailAttachments(resumeText, dossier, job) {
  if (!resumeText || !resumeText.trim()) return [];
  try {
    const data = await buildTailoredDocs(resumeText, dossier, job);
    const nm = clean(data?.contact?.name, "resume");
    const co = clean(job?.company, "role");
    const [resumePdf, coverPdf] = await Promise.all([
      renderResumePdf(data),
      renderCoverPdf(data, job?.company),
    ]);
    return [
      { filename: `${nm}-${co}-resume.pdf`, content: resumePdf.toString("base64") },
      { filename: `${nm}-${co}-cover.pdf`, content: coverPdf.toString("base64") },
    ];
  } catch (e) {
    console.error(`[tailored-docs] build failed (${e.message}) — sending without attachments`);
    return [];
  }
}
