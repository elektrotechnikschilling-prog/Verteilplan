/* Fotoauswertung: Fotos eines Verteilers -> Vorschlag fuer die Reihen des Plans.
   Die Fotos gehen direkt vom Geraet an die Claude-API von Anthropic (mit dem API-Schluessel, der nur
   auf diesem Geraet gespeichert ist). Kundenname und Adresse werden nicht mitgeschickt.
   Das Ergebnis ist ein Vorschlag: Unsicheres kommt als "unsicher" + "grund" zurueck und muss in der
   App bestaetigt werden, bevor der Plan fertig ist.

   FotoKI.bildVorbereiten(datei)              -> { daten (base64 JPEG), url (Vorschau), breite, hoehe }
   FotoKI.auswerten({ bilder, hinweis, schluessel, signal, mitSonstigen }) -> { reihen, offen, fotoHinweis, kosten, dauer } */
(function (global) {
  'use strict';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm';
  const MODELL = 'claude-opus-5-5';
  const PREIS = { ein: 4 / 1e6, aus: 20 / 1e6, cacheLesen: 0.2 / 1e6 };   // US-Dollar je Token (Claude Opus 5.5)
  const MAX_KANTE = 2576, MAX_PIXEL = 3.75e6;                            // groesste Bildgroesse, die das Modell nutzt
  const TYPEN = ['LS', 'RCD', 'FILS', 'AFDD', 'SLS', 'SI', 'SPD', 'HS', 'SCHUETZ', 'STS', 'UHR', 'TRAFO', 'ZAEHLER', 'SD', 'SONST', 'LEER'];
  const SCHUTZ = new Set(['LS', 'RCD', 'FILS', 'AFDD', 'SLS', 'SI']);

  let sdk = null;
  async function sdkLaden() {
    if (!sdk) sdk = import(SDK_URL).catch(e => { sdk = null; throw e; });
    return sdk;
  }

  /* ---------- Bilder verkleinern (Handyfotos haben oft 12–50 Megapixel) ---------- */
  async function bildVorbereiten(datei) {
    let quelle;
    try { quelle = await createImageBitmap(datei, { imageOrientation: 'from-image' }); }
    catch (e) {
      quelle = await new Promise((ok, fehl) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => fehl(new Error(`„${datei.name || 'Bild'}“ ist kein lesbares Foto.`));
        img.src = URL.createObjectURL(datei);
      });
    }
    const w = quelle.width, h = quelle.height;
    const f = Math.min(1, MAX_KANTE / Math.max(w, h), Math.sqrt(MAX_PIXEL / (w * h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * f));
    canvas.height = Math.max(1, Math.round(h * f));
    canvas.getContext('2d').drawImage(quelle, 0, 0, canvas.width, canvas.height);
    if (quelle.close) quelle.close();
    let qualitaet = 0.88, blob;
    do {
      blob = await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', qualitaet));
      qualitaet -= 0.1;
    } while (blob.size > 3.6e6 && qualitaet > 0.5);   // Base64 bleibt so unter 5 MB je Bild
    const daten = await new Promise((ok, fehl) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1]);
      r.onerror = () => fehl(r.error);
      r.readAsDataURL(blob);
    });
    return { daten, url: URL.createObjectURL(blob), breite: canvas.width, hoehe: canvas.height };
  }

  /* ---------- Was die KI liefern soll ---------- */
  const s = (beschreibung) => ({ type: 'string', description: beschreibung });
  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['reihen', 'offen', 'foto_hinweis'],
    properties: {
      reihen: {
        type: 'array',
        description: 'Alle Hutschienen-Reihen mit Geräten, von oben nach unten.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['art', 'breite_te', 'rcd_schutz', 'rcd_aus_reihe', 'geraete'],
          properties: {
            art: { type: 'string', enum: ['schutz', 'sonstige'], description: 'schutz = enthält LS, RCD, FI/LS, Sicherungen o. Ä.; sonstige = nur Zähler, Uhren, Relais, Netzteile usw.' },
            breite_te: { type: 'integer', description: 'Plätze der Reihe in TE inklusive freier Plätze (meist 12).' },
            rcd_schutz: { type: 'string', enum: ['eigener', 'keiner', 'andere_reihe', 'unklar'], description: 'Woher die Stromkreise der Reihe ihren Fehlerstromschutz bekommen.' },
            rcd_aus_reihe: { type: 'integer', description: 'Bei andere_reihe: Nummer der Reihe mit dem RCD, sonst 0.' },
            geraete: {
              type: 'array',
              description: 'Geräte von links nach rechts, lückenlos; freie Plätze als LEER.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['typ', 'te', 'pole', 'wert', 'art', 'text', 'hinweis', 'bezeichnung', 'unsicher', 'grund'],
                properties: {
                  typ: { type: 'string', enum: TYPEN },
                  te: { type: 'integer', description: 'Breite in Teilungseinheiten.' },
                  pole: { type: 'string', enum: ['', '1', '2', '3', '4', '1+N', '3+N'] },
                  wert: s('LS/FI-LS/AFDD/SLS: Kennung wie B16 oder C20. RCD: "40 A / 30 mA". Sonst Nennwert oder leer.'),
                  art: s('RCD und FI/LS: "Typ A", "Typ F", "Typ B" oder "Typ AC", sonst leer.'),
                  text: s('Stromkreis / Raum, wie er beschriftet ist. Leer, wenn nichts beschriftet ist.'),
                  hinweis: s('Ergänzung zum Stromkreis (z. B. "Steckdosen + Licht"), sonst leer.'),
                  bezeichnung: s('Typenbezeichnung des Geräts, z. B. "Hager MBS116", sonst leer.'),
                  unsicher: { type: 'boolean' },
                  grund: s('Nur wenn unsicher: kurz auf Deutsch, was nicht sicher erkannt wurde.')
                }
              }
            }
          }
        }
      },
      offen: { type: 'array', items: { type: 'string' }, description: 'Weitere offene Punkte für die Elektrofachkraft, auf Deutsch.' },
      foto_hinweis: s('Wenn Fotos fehlen oder zu unscharf sind: was noch fotografiert werden sollte. Sonst leer.')
    }
  };

  const SYSTEM = `Du wertest Fotos eines Elektro-Kleinverteilers (Unterverteilung mit Reiheneinbaugeräten auf Hutschienen) aus. Aus deinem Ergebnis entsteht ein Stromkreisverzeichnis für den Kunden. Eine Elektrofachkraft prüft und korrigiert es in einer App, bevor es ausgegeben wird. Der Plan ist sicherheitsrelevant: Gib nur an, was auf den Fotos zu sehen ist, und rate nicht. Was du nicht sicher erkennst, markierst du mit "unsicher": true und einem kurzen "grund" – das ist ausdrücklich erwünscht und keine Schwäche.

Die Fotos: meist ein Gesamtfoto und Nahaufnahmen einzelner Reihen, manchmal ein Beschriftungsstreifen oder eine Liste aus der Verteilertür. Mehrere Fotos zeigen oft dieselben Geräte – führe sie zu einem Ergebnis zusammen, ohne Geräte doppelt zu zählen. Nimm für Aufdrucke die schärfste Aufnahme.

Reihen und Plätze:
- Jede Hutschiene mit Geräten ist eine Reihe, gezählt von oben nach unten. Reihen, auf denen nichts montiert ist, lässt du weg.
- Die Geräte einer Reihe stehen lückenlos von links nach rechts. Freie Plätze und Blindabdeckungen sind LEER mit ihrer Breite. Freie Plätze am rechten Ende darfst du weglassen.
- Breite "te" in Teilungseinheiten: ein einpoliger LS ist 1 TE (ca. 18 mm) breit – nimm ihn als Maß. Typisch: RCD 4-polig 4 TE, RCD 2-polig 2 TE, LS 3-polig 3 TE, FI/LS 1+N 2 TE (kompakte Bauformen 1 TE).
- Die Plätze werden im Plan durchnummeriert (Reihe 1 = Platz 1–12, Reihe 2 = 13–24 …). Die Breiten müssen deshalb stimmen; zähle sorgfältig. Wenn die Summe nicht zur Reihe passt, setze beim fraglichen Gerät "unsicher".

Gerätetypen (typ): LS Leitungsschutzschalter · RCD Fehlerstrom-Schutzschalter · FILS FI/LS-Schalter (RCBO) · AFDD Brandschutzschalter · SLS selektiver Hauptleitungsschutzschalter · SI Schmelzsicherung (Neozed/Diazed) · SPD Überspannungsschutz · HS Hauptschalter/Lasttrennschalter · SCHUETZ Installationsschütz/Relais · STS Stromstoßschalter (Eltako o. Ä.) · UHR Zeitschaltuhr · TRAFO Klingeltrafo/Netzteil · ZAEHLER Zwischenzähler · SD Steckdose im Verteiler · SONST andere Geräte (in "text" kurz benennen) · LEER freier Platz.

Werte: Lies Kennung und Daten vom Aufdruck. Herstellerbezeichnungen darfst du deuten, wenn sie eindeutig sind (z. B. Hager MBS116 = B16 1-polig, MBN316 = B16 3-polig) – die Typenbezeichnung gehört dann in "bezeichnung". Ist ein Aufdruck nicht lesbar, lass "wert" leer und setze "unsicher". Beim RCD die Art (Typ A, F, B, AC) nur angeben, wenn Aufdruck oder Symbol sie zeigen.

Beschriftung ("text"): aus dem Beschriftungsstreifen am Gerät oder einer Liste in der Tür. Eine Liste ordnest du nur über eindeutige Nummern zu, die zu den Plätzen passen (z. B. nummerierter Streifen unter der Reihe). Durchgestrichenes gilt nicht; steht daneben etwas Neues, nimm das Neue. Übernimm die Schreibweise der Beschriftung, erfinde keine Raumnamen. Ohne Beschriftung bleibt "text" leer.

RCD-Zuordnung ("rcd_schutz"): "eigener", wenn in der Reihe links von den Stromkreisen ein RCD sitzt. "keiner" oder "andere_reihe" nur, wenn es auf den Fotos eindeutig zu sehen ist oder der Nutzer es angibt – sonst "unklar".

Schreibe alle Texte auf Deutsch. Fülle jedes Feld; was nicht zutrifft, bleibt ein leerer Text bzw. 0.`;

  function nachricht(bilder, hinweis) {
    const inhalt = [];
    bilder.forEach((b, i) => {
      inhalt.push({ type: 'text', text: `Foto ${i + 1} von ${bilder.length}:` });
      inhalt.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.daten } });
    });
    inhalt.push({ type: 'text', text: (hinweis && hinweis.trim()
      ? `Hinweise der Elektrofachkraft vor Ort (diese gehen vor):\n${hinweis.trim()}\n\n` : '')
      + 'Erfasse den Verteiler auf diesen Fotos.' });
    return inhalt;
  }

  /* ---------- Ergebnis der KI -> Reihen im Format des Plans ---------- */
  function zuPlanReihen(erg, mitSonstigen) {
    const offen = (erg.offen || []).map(t => String(t).trim()).filter(Boolean);
    const alle = (erg.reihen || []).filter(r => (r.geraete || []).some(g => g.typ !== 'LEER'));
    const genommen = alle.filter(r => mitSonstigen || r.art === 'schutz' || r.geraete.some(g => SCHUTZ.has(g.typ)));
    const weg = alle.length - genommen.length;
    if (weg) offen.push(`${weg} Reihe${weg > 1 ? 'n' : ''} ohne Schutzgeräte (Zähler, Uhren o. Ä.) nicht übernommen`);
    const neueNummer = new Map(genommen.map((r, i) => [alle.indexOf(r) + 1, i + 1]));
    const teVon = global.Verteilerplan ? global.Verteilerplan.teVon : (g => Number(g.te) || 1);

    const reihen = genommen.map((r, ri) => {
      const geraete = [];
      for (const k of r.geraete || []) {
        const typ = TYPEN.includes(k.typ) ? k.typ : 'SONST';
        const g = { typ };
        if (k.pole) g.pole = /^\d+$/.test(k.pole) ? Number(k.pole) : k.pole;
        if (g.pole === 1 && typ === 'LS') delete g.pole;
        for (const f of ['wert', 'art', 'text', 'hinweis']) {
          const v = String(k[f] || '').trim();
          if (v && typ !== 'LEER') g[f] = v;
        }
        if (/^res(\.|erve)?$/i.test(g.text || '')) g.text = 'Reserve';
        const te = Math.max(1, Math.round(Number(k.te) || 1));
        if (typ === 'LEER' || te !== teVon(g)) g.te = te;
        if (k.bezeichnung && String(k.bezeichnung).trim()) g.typbez = String(k.bezeichnung).trim();
        if (k.unsicher) { g.unsicher = true; g.grund = String(k.grund || '').trim() || 'von der Fotoauswertung als unsicher markiert'; }
        const vor = geraete[geraete.length - 1];
        if (typ === 'LEER' && vor && vor.typ === 'LEER') vor.te += te; else geraete.push(g);
      }
      while (geraete.length && geraete[geraete.length - 1].typ === 'LEER') geraete.pop();
      const reihe = { geraete };
      const breite = Number(r.breite_te) || 12;
      if (breite > 12) offen.push(`Reihe ${ri + 1} hat ${breite} TE – der Plan ist für 12 TE je Reihe ausgelegt, bitte prüfen`);
      if (!geraete.some(g => g.typ === 'RCD') && geraete.some(g => ['LS', 'SI', 'AFDD'].includes(g.typ))) {
        const quelle = neueNummer.get(Number(r.rcd_aus_reihe));
        if (r.rcd_schutz === 'keiner') reihe.rcd = 'ohne';
        else if (r.rcd_schutz === 'andere_reihe' && quelle) reihe.rcd = rcdNummerVonReihe(genommen, quelle);
        else {
          reihe.rcd = '?';
          offen.push(`Reihe ${ri + 1} hat keinen eigenen RCD – welcher RCD schützt sie (oder keiner)?`);
        }
        if (reihe.rcd === null) { reihe.rcd = '?'; offen.push(`Reihe ${ri + 1}: RCD-Zuordnung unklar`); }
      }
      return reihe;
    });
    return { reihen, offen };
  }

  // Nummer des ersten RCD in Reihe nr (RCDs zaehlen in der Reihenfolge ihres Auftretens)
  function rcdNummerVonReihe(reihen, nr) {
    let n = 0;
    for (let i = 0; i < reihen.length; i++) {
      for (const g of reihen[i].geraete || []) {
        if (g.typ === 'RCD') { n++; if (i + 1 === nr) return n; }
      }
    }
    return null;
  }

  /* ---------- Anfrage ---------- */
  async function auswerten({ bilder, hinweis, schluessel, signal, mitSonstigen }) {
    if (!bilder || !bilder.length) throw new Error('Bitte zuerst Fotos aufnehmen oder auswählen.');
    if (!schluessel) throw new Error('Für die Fotoauswertung fehlt der API-Schlüssel.');
    let mod;
    try { mod = await sdkLaden(); }
    catch (e) { throw new Error('Die KI-Anbindung konnte nicht geladen werden. Bitte Internetverbindung prüfen.'); }
    const Anthropic = mod.default;
    const client = new Anthropic({ apiKey: schluessel, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 10 * 60 * 1000 });
    const start = Date.now();
    let antwort;
    try {
      const stream = client.beta.messages.stream({
        model: MODELL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: nachricht(bilder, hinweis) }]
      }, { signal });
      antwort = await stream.finalMessage();
    } catch (e) {
      throw new Error(fehlertext(e, Anthropic));
    }
    if (antwort.stop_reason === 'refusal') throw new Error('Die KI hat die Auswertung abgelehnt. Bitte andere Fotos versuchen oder den Verteiler von Hand eintragen.');
    if (antwort.stop_reason === 'max_tokens') throw new Error('Die Antwort der KI war zu lang und ist unvollständig. Bitte mit weniger Fotos noch einmal versuchen.');
    const text = antwort.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let erg;
    try { erg = JSON.parse(text); } catch (e) { throw new Error('Die Antwort der KI war nicht lesbar. Bitte noch einmal versuchen.'); }
    const u = antwort.usage || {};
    const kosten = (u.input_tokens || 0) * PREIS.ein + (u.cache_creation_input_tokens || 0) * PREIS.ein * 1.25
      + (u.cache_read_input_tokens || 0) * PREIS.cacheLesen + (u.output_tokens || 0) * PREIS.aus;
    const plan = zuPlanReihen(erg, mitSonstigen);
    return { ...plan, fotoHinweis: String(erg.foto_hinweis || '').trim(), kosten, dauer: Math.round((Date.now() - start) / 1000) };
  }

  // Prueft einen neuen Schluessel mit einer kostenlosen Abfrage (Modell-Infos)
  async function pruefen(schluessel) {
    let mod;
    try { mod = await sdkLaden(); }
    catch (e) { throw new Error('Die KI-Anbindung konnte nicht geladen werden. Bitte Internetverbindung prüfen.'); }
    const Anthropic = mod.default;
    const client = new Anthropic({ apiKey: schluessel, dangerouslyAllowBrowser: true, maxRetries: 1 });
    try { await client.models.retrieve(MODELL); }
    catch (e) { throw new Error(fehlertext(e, Anthropic)); }
  }

  function fehlertext(e, A) {
    if (e instanceof A.APIUserAbortError || (e && e.name === 'AbortError')) return 'Auswertung abgebrochen.';
    if (e instanceof A.AuthenticationError) return 'Der API-Schlüssel wird nicht angenommen. Bitte den Schlüssel prüfen (platform.claude.com → API Keys).';
    if (e instanceof A.PermissionDeniedError) return 'Der API-Schlüssel hat keine Berechtigung für diese Auswertung.';
    if (e instanceof A.RateLimitError) return 'Gerade zu viele Anfragen – bitte eine Minute warten und noch einmal versuchen.';
    if (e instanceof A.BadRequestError) {
      if (/credit|balance|billing/i.test(e.message)) return 'Das Guthaben im Anthropic-Konto ist aufgebraucht. Bitte unter platform.claude.com → Billing aufladen.';
      return 'Die Anfrage wurde abgelehnt: ' + kurz(e);
    }
    if (e instanceof A.APIConnectionTimeoutError) return 'Die Auswertung hat zu lange gedauert. Bitte noch einmal versuchen.';
    if (e instanceof A.APIConnectionError) return 'Keine Verbindung zur KI. Bitte Internetverbindung prüfen.';
    if (e instanceof A.InternalServerError) return 'Der KI-Dienst ist gerade überlastet. Bitte gleich noch einmal versuchen.';
    if (e instanceof A.APIError) return `Fehler der KI (${e.status || '?'}): ` + kurz(e);
    return 'Unerwarteter Fehler: ' + (e && e.message ? e.message : String(e));
  }
  function kurz(e) {
    const m = e && e.error && e.error.error && e.error.error.message;
    return String(m || e.message || e).slice(0, 200);
  }

  global.FotoKI = { bildVorbereiten, auswerten, pruefen, zuPlanReihen, sdkLaden, MODELL };
})(window);
