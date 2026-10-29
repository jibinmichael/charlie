// quality-gate.test.mjs — homeRegion + reachableForRegion, with a focus on the out-of-market ("other")
// path. A candidate whose GROUNDED home is outside the served markets must not default to "india" and
// get emailed India roles: homeRegion returns "other" for a POSITIVE foreign signal, so the person is
// routed to an honest note instead, WITHOUT ever misflagging a genuine India/US user.
import { describe, it, expect } from "vitest";
import { homeRegion, reachableForRegion, reachabilityVerdict } from "./quality-gate.mjs";

describe("homeRegion — out-of-market detection (positive foreign signal only)", () => {
  // The out-of-market shape: no India/US signal anywhere, EUR currency, and "Lisbon" stated in the
  // remote preference. This must be "other", never the "india" default.
  it("EUR + 'Lisbon' in the remote preference → other, not the india default", () => {
    const d = { preferences: { remote: "Hybrid in Lisbon or fully remote", comp_currency: "EUR" } };
    expect(homeRegion(d)).toBe("other");
  });

  it("grounded home_place classifies deterministically", () => {
    expect(homeRegion({ preferences: { home_place: "Lisbon, Portugal" } })).toBe("other");
    expect(homeRegion({ preferences: { home_place: "Singapore" } })).toBe("other");
    expect(homeRegion({ preferences: { home_place: "Bengaluru, India" } })).toBe("india");
    expect(homeRegion({ preferences: { home_place: "Austin, TX" } })).toBe("us");
  });

  it("a non-INR/USD home currency alone signals 'other'", () => {
    for (const cur of ["EUR", "GBP", "AED", "SGD", "CAD", "AUD"]) {
      expect(homeRegion({ preferences: { comp_currency: cur } })).toBe("other");
    }
  });

  // The fail-closed constraint: NEVER tell a real India/US user we don't serve them.
  it("does NOT misflag an India user who merely mentions foreign clients", () => {
    expect(homeRegion({ headline: "Designer for UK and European clients", preferences: { comp_currency: "INR" } })).toBe("india");
    // even with no explicit India field, a passing foreign mention in the HEADLINE is not a home
    expect(homeRegion({ headline: "Worked with UK startups" })).toBe("india");
  });

  it("India + US signals still win, and a truly-unknown region still defaults to India", () => {
    expect(homeRegion({ headline: "Product Designer based in Bengaluru" })).toBe("india");
    expect(homeRegion({ preferences: { comp_currency: "INR" } })).toBe("india");
    expect(homeRegion({ headline: "Engineer in San Francisco" })).toBe("us");
    expect(homeRegion({ preferences: { comp_currency: "USD" } })).toBe("us");
    expect(homeRegion({ headline: "Senior Product Designer" })).toBe("india"); // anti-leak default preserved
  });

  it("a junk/non-place home_place (e.g. 'Remote') falls through, never a false 'other'", () => {
    expect(homeRegion({ preferences: { home_place: "Remote" } })).toBe("india");
    expect(homeRegion({ preferences: { home_place: "Anywhere" } })).toBe("india");
  });
});

describe("reachableForRegion — 'other' fails closed", () => {
  // Defense in depth: "other" users are dropped before scoring, but if one ever reaches the gate,
  // NOTHING is reachable — silence, never a leaked foreign role. An unknown region must not fall
  // through to `!placeRe → return true` (a leak).
  it("no job is reachable for an out-of-market person", () => {
    for (const job of [{ location: "Bengaluru, India" }, { location: "United States (Remote)" }, { location: "Remote", remote: true }, { location: "Porto, Portugal" }]) {
      expect(reachableForRegion(job, "other")).toBe(false);
    }
  });

  it("the existing india/us geo behavior is unchanged", () => {
    expect(reachableForRegion({ location: "United States (Remote)" }, "india")).toBe(false);
    expect(reachableForRegion({ location: "Bengaluru, India" }, "india")).toBe(true);
    expect(reachableForRegion({ location: "Remote", remote: true }, "us")).toBe(true);
  });
});

// reachabilityVerdict labels WHICH branch decided the geo
// gate, so the pre-filter can COUNT the one recoverable case ("remote-company-unconfirmed") in shadow
// without changing the drop. These tests lock two things: (1) the wrapper equivalence — reachableForRegion
// is exactly reachabilityVerdict(...).reachable; (2) the basis is
// assigned ONLY to the genuine bare-remote-companyHiresIndia===false drop, never to a correctly-blocked
// foreign / restricted / onsite role — so it stays a narrow measurement, not a broad geo loosening.
describe("reachabilityVerdict — basis labeling (shadow discrimination)", () => {
  it("wrapper equivalence: reachableForRegion === reachabilityVerdict(...).reachable", () => {
    const cases = [
      [{ location: "Remote", companyHiresIndia: false }, "india"],
      [{ location: "Remote", companyHiresIndia: true }, "india"],
      [{ location: "United States (Remote)" }, "india"],
      [{ location: "Bengaluru, India" }, "india"],
      [{ location: "In-Office", title: "Data Scientist", companyHiresIndia: true }, "india"],
      [{ remote: true, location: "Remote", description: "must be authorized to work in the United States" }, "india"],
      [{ location: "Remote", companyHiresIndia: false }, "us"],
      [{ location: "Bengaluru, India" }, "other"],
    ];
    for (const [job, region] of cases) {
      expect(reachabilityVerdict(job, region).reachable).toBe(reachableForRegion(job, region));
    }
  });

  // THE target: a placeless bare-remote role, no home place, no explicit-open signal, dropped ONLY
  // because the company isn't tagged as India-hiring. This is the recoverable set.
  it("flags the genuine bare-remote / companyHiresIndia===false drop", () => {
    const v = reachabilityVerdict({ location: "Remote", companyHiresIndia: false }, "india");
    expect(v.reachable).toBe(false);
    expect(v.basis).toBe("remote-company-unconfirmed");
  });

  // Same shape but the company IS tagged India-hiring → reachable today, a DISTINCT basis, never counted.
  it("a company-confirmed bare-remote role is reachable and NOT the recoverable basis", () => {
    const v = reachabilityVerdict({ location: "Remote", companyHiresIndia: true }, "india");
    expect(v.reachable).toBe(true);
    expect(v.basis).toBe("remote-company-confirmed");
  });

  // The anti-over-flag battery: every one of these is correctly blocked for a REASON OTHER than the weak
  // company signal, so none may carry the recoverable basis — else it would loosen the moat broadly.
  it("correctly-blocked foreign / restricted / onsite roles are NEVER the recoverable basis", () => {
    const notRecoverable = [
      [{ location: "United States (Remote)", companyHiresIndia: false }, "foreign-place-named"],
      [{ remote: true, location: "Remote", description: "must be authorized to work in the United States", companyHiresIndia: false }, "remote-restricted"],
      [{ location: "In-Office", title: "Data Scientist", companyHiresIndia: false }, "onsite-no-city"],
      [{ location: "", remote: false, companyHiresIndia: false }, "no-location-not-remote"],
    ];
    for (const [job, expectedBasis] of notRecoverable) {
      const v = reachabilityVerdict(job, "india");
      expect(v.reachable).toBe(false);
      expect(v.basis).toBe(expectedBasis);
      expect(v.basis).not.toBe("remote-company-unconfirmed");
    }
  });

  // The recoverable basis is India-only by construction: a US person's placeless bare-remote role defaults reachable and is
  // never a recovery candidate (the whole point is India's structural supply cap).
  it("a US person's bare-remote role is never the recoverable basis", () => {
    const v = reachabilityVerdict({ location: "Remote", companyHiresIndia: false }, "us");
    expect(v.reachable).toBe(true);
    expect(v.basis).toBe("us-remote-default");
  });
});

// ── MULTI_REGION: opening Canada + Australia as real markets ────────────────────────────────────
// Without MULTI_REGION a Toronto dossier is "other" and reachabilityVerdict returns reachable:false for
// it on every role; every assertion below depends on the multi-region code paths.
describe("MULTI_REGION — ca/au as markets", () => {
  const withFlag = (v, fn) => {
    const prev = process.env.MULTI_REGION;
    if (v === undefined) delete process.env.MULTI_REGION; else process.env.MULTI_REGION = v;
    try { return fn(); } finally { if (prev === undefined) delete process.env.MULTI_REGION; else process.env.MULTI_REGION = prev; }
  };
  const dossier = (place) => ({ preferences: { home_place: place } });

  it("OFF (default): ca/au are still out-of-market — today's behaviour, byte for byte", () => {
    withFlag(undefined, () => {
      expect(homeRegion(dossier("Toronto, Canada"))).toBe("other");
      expect(homeRegion(dossier("Sydney, Australia"))).toBe("other");
      expect(reachableForRegion({ location: "Toronto, Canada" }, "other")).toBe(false);
    });
  });

  it("ON: a Toronto dossier is 'ca' and a Sydney dossier is 'au'", () => {
    withFlag("on", () => {
      expect(homeRegion(dossier("Toronto, Canada"))).toBe("ca");
      expect(homeRegion(dossier("Vancouver, BC"))).toBe("ca");
      expect(homeRegion(dossier("Sydney"))).toBe("au");
      expect(homeRegion(dossier("Melbourne, Australia"))).toBe("au");
      expect(homeRegion({ preferences: { comp_currency: "CAD" } })).toBe("ca");
      expect(homeRegion({ preferences: { comp_currency: "AUD" } })).toBe("au");
    });
  });

  it("ON: the 835 pool shapes actually resolve — real location strings from jobs.json", () => {
    withFlag("on", () => {
      for (const loc of ["Toronto", "Canada", "Remote Canada", "Toronto, Ontario, Canada", "Vancouver, BC", "Remote (Canada)", "Mississauga, Ontario, Canada"])
        expect(reachableForRegion({ location: loc }, "ca"), loc).toBe(true);
      for (const loc of ["Sydney", "Australia", "Melbourne", "Sydney, Australia", "Remote - Australia", "Sydney, AU"])
        expect(reachableForRegion({ location: loc }, "au"), loc).toBe(true);
    });
  });

  it("ON: multi-region strings reach BOTH markets off the same text", () => {
    withFlag("on", () => {
      for (const loc of ["Remote (United States | Canada)", "Remote, Canada; Remote, US", "US and Canada Offices"]) {
        expect(reachableForRegion({ location: loc }, "ca"), loc).toBe(true);
        expect(reachableForRegion({ location: loc }, "us"), loc).toBe(true);
      }
    });
  });

  it("ON: cross-market roles stay blocked in every direction", () => {
    withFlag("on", () => {
      expect(reachableForRegion({ location: "Seattle, WA" }, "au")).toBe(false);   // Perth user, Seattle desk
      expect(reachableForRegion({ location: "Seattle, WA" }, "ca")).toBe(false);
      expect(reachableForRegion({ location: "Toronto, Canada" }, "india")).toBe(false);
      expect(reachableForRegion({ location: "Sydney, Australia" }, "india")).toBe(false);
      expect(reachableForRegion({ location: "Sydney, Australia" }, "us")).toBe(false);
      expect(reachableForRegion({ location: "Bengaluru, India" }, "ca")).toBe(false);
      expect(reachableForRegion({ location: "Toronto, Canada" }, "au")).toBe(false);
    });
  });

  it("ON: a US homonym city is refused as ca/au, never leaked into the wrong inbox", () => {
    withFlag("on", () => {
      expect(homeRegion(dossier("Melbourne, FL"))).not.toBe("au");
      expect(homeRegion(dossier("Ontario, California"))).not.toBe("ca");
      expect(reachableForRegion({ location: "Melbourne, FL" }, "au")).toBe(false);
      expect(reachableForRegion({ location: "Brisbane, CA" }, "au")).toBe(false);
      expect(reachableForRegion({ location: "Vancouver, WA" }, "ca")).toBe(false);
    });
  });

  it("ON: a placeless bare-remote role fails CLOSED in ca/au (companyHiresIndia is not evidence)", () => {
    withFlag("on", () => {
      const v = reachabilityVerdict({ location: "Remote", companyHiresIndia: true }, "ca");
      expect(v.reachable).toBe(false);
      expect(v.basis).toBe("remote-no-market-signal");
      expect(reachableForRegion({ location: "Remote", companyHiresIndia: true }, "au")).toBe(false);
    });
  });

  it("ON changes NOTHING for India or US — the regression guard on the live markets", () => {
    const cases = [
      [{ location: "Bengaluru, India" }, "india"], [{ location: "United States (Remote)" }, "india"],
      [{ location: "Remote", companyHiresIndia: true }, "india"], [{ location: "Remote", companyHiresIndia: false }, "india"],
      [{ location: "Remote" }, "india"], [{ location: "Seattle, WA" }, "us"],
      [{ location: "Bengaluru, India" }, "us"], [{ location: "Remote", companyHiresIndia: false }, "us"],
      [{ location: "Remote - OR", companyHiresIndia: true }, "india"], [{ location: "", remote: false }, "india"],
    ];
    for (const [job, region] of cases) {
      const off = withFlag(undefined, () => reachabilityVerdict(job, region));
      const on = withFlag("on", () => reachabilityVerdict(job, region));
      expect(on, `${JSON.stringify(job)} @ ${region}`).toEqual(off);
    }
    for (const d of [{ preferences: { home_place: "Bengaluru" } }, { preferences: { home_place: "Austin" } }, { preferences: { comp_currency: "INR" } }, { preferences: { comp_currency: "USD" } }, {}])
      expect(withFlag("on", () => homeRegion(d))).toBe(withFlag(undefined, () => homeRegion(d)));
  });
});

// ── US state NAMES in the location field ────────────────────────────────────────────────────────
// An employer writing the state instead of the city ("Chandler, Arizona", "Hoover, Alabama") must not
// produce `foreign-place-named` for a US user; a correct-looking verdict would otherwise quietly
// discard real US inventory (fail-closed becoming fail-to-zero).
//
// US_PLACE carries state NAMES only. Every assertion in the second block below FAILS the moment a bare
// two-letter code is added to US_PLACE — see the block comment there for why such codes in the pool
// are ISO COUNTRY codes, not state codes.
describe("US state names — real US roles must not read as foreign", () => {
  const usReach = (location) => reachabilityVerdict({ location }, "us");

  it("a state-name location is reachable for a US candidate", () => {
    for (const loc of [
      "Chandler, Arizona", "Hoover, Alabama", "Phoenix, Arizona", "Rhode Island",
      "Arizona; California; Utah", "Virginia Beach, VA", "Nashville, Tennessee",
      "Columbus, Ohio", "Salt Lake City, Utah", "Remote - Texas",
    ]) {
      const v = usReach(loc);
      expect(v.reachable, `${loc} -> ${v.basis}`).toBe(true);
      expect(v.basis).toBe("home-place-named");
    }
  });

  it("a state name also classifies a candidate's home as US (one seam, job side and user side agree)", () => {
    expect(homeRegion({ preferences: { home_place: "Chandler, Arizona" } })).toBe("us");
    expect(homeRegion({ preferences: { home_place: "Nashville, Tennessee" } })).toBe("us");
  });
});

describe("US state names — the collisions that must NOT be introduced", () => {
  const usReach = (location) => reachabilityVerdict({ location }, "us");

  it("a bare two-letter prefix stays un-decoded: these are ISO COUNTRY codes in the live pool", () => {
    // The "XX - City" shape in the pool is a country code, not a state code: CA -> Toronto,
    // DE -> Berlin, IN -> Bangalore, GB -> London, AE -> Dubai. Reading the code as a US state would
    // put a Toronto/Berlin/Bangalore role in a US inbox — unrecoverable, so fail closed.
    for (const loc of ["CA - Toronto", "DE - Berlin", "IN - Bangalore", "GB - London", "AE - Dubai"]) {
      expect(usReach(loc).reachable, loc).toBe(false);
    }
  });

  it("Georgia the COUNTRY is not the US state (georgia is deliberately excluded from US_PLACE)", () => {
    expect(usReach("Tbilisi, Georgia").reachable).toBe(false);
    expect(homeRegion({ preferences: { home_place: "Tbilisi, Georgia" } })).not.toBe("us");
  });

  it("state names do not leak into the India or CA/AU verdicts", () => {
    expect(reachabilityVerdict({ location: "Chandler, Arizona" }, "india").reachable).toBe(false);
    expect(reachabilityVerdict({ location: "Bengaluru, India" }, "us").reachable).toBe(false);
  });
});

// ── "City, ST": most American postings are written this way ────────────────────────────────────
//
// US_PLACE matches place NAMES and never bare two-letter codes, deliberately, because a loose "WA" is
// Western Australia and a loose "CA" is Canada. The "City, ST" shape is handled separately, so a plain
// American posting whose city is not on the hand-written city list is still reachable for a US user.
// The negative assertions are the fence.
describe("US City, ST — recovers American roles without letting the world in", () => {
  const at = (location) => reachabilityVerdict({ id: "greenhouse:a:1", location, description: "x".repeat(200) }, "us").reachable;

  it("recovers US cities that are not on the hand-written city list", () => {
    for (const loc of ["Hawthorne, CA", "Redmond, WA", "Bastrop, TX", "Long Beach, CA", "Broomfield, CO", "Annapolis, MD", "Shreveport, LA"]) {
      expect(at(loc), `${loc} should be reachable for a US user`).toBe(true);
    }
  });

  it("still reads the country suffix when it is there", () => {
    expect(at("Austin, TX, USA")).toBe(true);
    expect(at("Princeton, NJ, United States")).toBe(true);
  });

  it("MELBOURNE, FL IS FLORIDA — the homonym guard must not eat it", () => {
    // Guarding on every Australian city name would hide Florida from Americans: the same homonym bug
    // the CA_PLACE/AU_PLACE comment warns about, in reverse. The Australia guard applies to WA alone.
    expect(at("Melbourne, FL")).toBe(true);
  });

  it("PERTH, WA IS AUSTRALIA — and Seattle, WA is not", () => {
    expect(at("Perth, WA")).toBe(false);
    expect(at("Seattle, WA")).toBe(true);
  });

  it("a country prefix is not a state code — the comma anchor is what separates them", () => {
    // "CA - Toronto" and "IN - Bangalore" are country codes. Matching a bare code would read them as
    // California and Indiana and send someone a job on the wrong continent.
    for (const loc of ["CA - Toronto", "IN - Bangalore", "DE - Berlin"]) {
      expect(at(loc), `${loc} must not read as US`).toBe(false);
    }
  });

  it("does not open the rest of the world", () => {
    for (const loc of ["Toronto, ON", "Vancouver, BC", "London, UK", "Bengaluru, India", "Berlin, Germany", "Singapore", "Sydney, NSW", "Melbourne, VIC"]) {
      expect(at(loc), `${loc} must not read as US`).toBe(false);
    }
  });

  it("changes nothing for an India user", () => {
    const forIndia = (location) => reachabilityVerdict({ id: "greenhouse:a:1", location, description: "x".repeat(200) }, "india").reachable;
    expect(forIndia("Hawthorne, CA")).toBe(false);
    expect(forIndia("Bengaluru, India")).toBe(true);
  });
});


// ── India by the names employers actually post ───────────────────────────────────────────────────
//
// The INDIA list must cover tier-2 cities and states, not only the biggest metros: "Kochi (Kerala)",
// "Coimbatore (Tamil Nadu)", "Trivandrum (Kerala)" and "Indore (MP)" would otherwise read as FOREIGN
// and be dropped for every Indian user. India-native boards concentrate in exactly those cities.
describe("India is recognised by city and state, not only by the word India", () => {
  const at = (location) => reachabilityVerdict({ id: "keka:a:1", location, description: "x".repeat(200) }, "india").reachable;

  it("recognises Kerala and Tamil Nadu cities written with the state in brackets", () => {
    // Real posting strings. Employers write "Kochi (Kerala)" far more often than
    // "Kochi, India", which is why states had to be included and not just cities.
    for (const loc of ["Kochi (Kerala)", "Ernakulam (Kerala)", "Trivandrum (Kerala)", "Coimbatore (Tamil Nadu)", "Kozhikode", "Thrissur"]) {
      expect(at(loc), loc).toBe(true);
    }
  });

  it("recognises tier-2 cities across the country", () => {
    for (const loc of ["Indore (MP)", "Jaipur", "Nagpur", "Bhubaneswar", "Mysuru, Karnataka", "Thane", "Chandigarh", "Guwahati"]) {
      expect(at(loc), loc).toBe(true);
    }
  });

  it("still recognises the metros it always did", () => {
    for (const loc of ["Bengaluru, India", "Mumbai", "Chennai, Tamil Nadu, India", "Gurugram", "Noida"]) {
      expect(at(loc), loc).toBe(true);
    }
  });

  it("does NOT open the rest of the world", () => {
    // The widening must not turn into "anywhere is India". These are the fence.
    for (const loc of ["Berlin, Germany", "Singapore", "London, UK", "Austin, TX", "Toronto, Canada", "Dubai", "Seoul, South Korea", "Sydney, Australia"]) {
      expect(at(loc), loc).toBe(false);
    }
  });

  it("omits Punjab on purpose — it spans two countries", () => {
    // The Punjabi CITIES are listed instead, so an Indian role still resolves without the ambiguous
    // state name waving through a Pakistani one.
    expect(at("Mohali")).toBe(true);
    expect(at("Ludhiana")).toBe(true);
  });
});
