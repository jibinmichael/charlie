// resume-pdf.tsx — the ATS-safe document template. Single column, real selectable text,
// Helvetica body (ATS-standard) with the Sanchez brand slab on the NAME only, clear section
// headers, no tables/columns/graphics. Renders resume-build.mjs data into a résumé + cover PDF.
//
// Two house rules baked in: (1) NO em dashes anywhere (they read as AI) — every string runs
// through txt() which swaps them for commas; (2) NO placeholder text — present() drops
// "Not specified" / "N/A" / "-" so nothing empty ever prints.
//
// Typography follows resume-design rules: body/bullets ~10.5pt (11 sweet spot), name 22pt,
// section headers stepped above body, leading ~1.4 (120-145% of size), ~0.7in margins, one
// consistent 4pt-ish spacing rhythm. Sanchez (OFL, embedded as a TTF data URI) sets the name;
// the body stays Helvetica so ATS parsing is never at risk (the text is real either way).

import React from "react";
import { Document, Page, Text, View, StyleSheet, Font, renderToBuffer } from "@react-pdf/renderer";
// @ts-ignore — plain ESM JS, TTF data URI for the brand slab (name only)
import { SANCHEZ_TTF } from "./sanchez-ttf.mjs";

Font.register({ family: "Sanchez", src: SANCHEZ_TTF });
// react-pdf hyphenates by default; resumes read cleaner with whole words (ragged right).
Font.registerHyphenationCallback((word) => [word]);

const INK = "#1A1A1A";
const MUTE = "#555555";
const RULE = "#C4C4C4";
const SEP = "  ·  ";

const PLACEHOLDER = /^(not specified|not provided|n\/?a|none|unknown|tbd|-|—)$/i;
// swap em/en dashes for commas (kills the "AI" tell), collapse space, trim
function txt(v?: string | null): string {
  return String(v ?? "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2") // keep date/number ranges readable (2007-2010)
    .replace(/\s*[—–]\s*/g, ", ") // em/en dashes in prose -> comma (the "AI" tell)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
// txt + drop pure-placeholder values so nothing empty prints
function present(v?: string | null): string {
  const t = txt(v);
  return PLACEHOLDER.test(t) ? "" : t;
}

const s = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 48, paddingHorizontal: 50, fontFamily: "Helvetica", color: INK, fontSize: 10.5, lineHeight: 1.4 },
  name: { fontSize: 22, fontFamily: "Sanchez", letterSpacing: 0.2 },
  contact: { fontSize: 9.5, color: MUTE, marginTop: 13, lineHeight: 1.4 },
  section: { marginTop: 20 },
  h: { fontSize: 10.5, fontFamily: "Sanchez", letterSpacing: 0.8, textTransform: "uppercase", borderBottomWidth: 0.8, borderBottomColor: RULE, paddingBottom: 5, marginBottom: 9 },
  summary: { fontSize: 10.5, color: INK, lineHeight: 1.45 },
  job: { marginBottom: 12 },
  jobHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 3 },
  jobTitle: { fontSize: 11, fontFamily: "Sanchez" },
  jobOrg: { fontSize: 10.5, color: INK },
  jobMeta: { fontSize: 9.5, color: MUTE, textAlign: "right" },
  bulletRow: { flexDirection: "row", marginTop: 4, paddingRight: 4 },
  dot: { width: 12, fontSize: 10.5, color: MUTE },
  bulletText: { flex: 1, fontSize: 10.5, lineHeight: 1.4 },
  skills: { fontSize: 10.5, lineHeight: 1.5 },
  eduRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 5 },
  eduLeft: { fontSize: 10.5 },
  eduMeta: { fontSize: 9.5, color: MUTE },
  coverDate: { fontSize: 9.5, color: MUTE, marginTop: 24 },
  coverTo: { fontSize: 10.5, color: INK, marginTop: 4, marginBottom: 16 },
  coverP: { fontSize: 10.5, lineHeight: 1.5, marginBottom: 12 },
  coverSign: { fontSize: 10.5, lineHeight: 1.5, marginTop: 10 },
});

function contactLine(c: any): string {
  return [c?.email, c?.phone, c?.location, ...(Array.isArray(c?.links) ? c.links : [])].map(present).filter(Boolean).join(SEP);
}

function Header({ contact }: { contact: any }) {
  const line = contactLine(contact);
  return (
    <View>
      <Text style={s.name}>{present(contact?.name) || "Your Name"}</Text>
      {line ? <Text style={s.contact}>{line}</Text> : null}
    </View>
  );
}

export function ResumeDoc({ data }: { data: any }) {
  const exp = Array.isArray(data?.experience) ? data.experience : [];
  const edu = Array.isArray(data?.education) ? data.education : [];
  const skills = (Array.isArray(data?.skills) ? data.skills : []).map(present).filter(Boolean);
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Header contact={data?.contact} />
        {present(data?.summary) ? (
          <View style={s.section}>
            <Text style={s.h}>Summary</Text>
            <Text style={s.summary}>{txt(data.summary)}</Text>
          </View>
        ) : null}
        {exp.length ? (
          <View style={s.section}>
            <Text style={s.h}>Experience</Text>
            {exp.map((e: any, i: number) => {
              const title = present(e.title), org = present(e.org);
              const meta = [present(e.dates), present(e.location)].filter(Boolean).join(SEP);
              const bullets = (Array.isArray(e.bullets) ? e.bullets : []).map(txt).filter(Boolean);
              return (
                <View key={i} style={s.job} wrap={false}>
                  <View style={s.jobHead}>
                    <Text style={s.jobTitle}>
                      {title}{org ? <Text style={s.jobOrg}>{title ? ", " : ""}{org}</Text> : null}
                    </Text>
                    {meta ? <Text style={s.jobMeta}>{meta}</Text> : null}
                  </View>
                  {bullets.map((b: string, j: number) => (
                    <View style={s.bulletRow} key={j}>
                      <Text style={s.dot}>•</Text>
                      <Text style={s.bulletText}>{b}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}
        {skills.length ? (
          <View style={s.section}>
            <Text style={s.h}>Skills</Text>
            <Text style={s.skills}>{skills.join(SEP)}</Text>
          </View>
        ) : null}
        {edu.length ? (
          <View style={s.section}>
            <Text style={s.h}>Education</Text>
            {edu.map((e: any, i: number) => {
              const parts = [present(e.school), present(e.credential)].filter(Boolean);
              const left = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i).join(SEP);
              if (!left && !present(e.dates)) return null;
              return (
                <View style={s.eduRow} key={i}>
                  <Text style={s.eduLeft}>{left}</Text>
                  <Text style={s.eduMeta}>{present(e.dates)}</Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export function CoverDoc({ data, company }: { data: any; company?: string }) {
  const paras = txt(data?.cover).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Header contact={data?.contact} />
        {present(company)
          ? <Text style={s.coverTo}>Dear Hiring Team at {present(company)},</Text>
          : <Text style={s.coverTo}>Dear Hiring Team,</Text>}
        {paras.length ? paras.map((p, i) => <Text style={s.coverP} key={i}>{p}</Text>) : <Text style={s.coverP}>{txt(data?.cover)}</Text>}
        <Text style={s.coverSign}>Sincerely,{"\n"}{present(data?.contact?.name) || "Your Name"}</Text>
      </Page>
    </Document>
  );
}

export async function renderResumePdf(data: any): Promise<Buffer> {
  return await renderToBuffer(<ResumeDoc data={data} />);
}
export async function renderCoverPdf(data: any, company?: string): Promise<Buffer> {
  return await renderToBuffer(<CoverDoc data={data} company={company} />);
}
