# Oasis Live '27 Registration Bot

Meldet E-Mail-Adressen aus einer CSV-Datei automatisch bei der
[Oasis Live '27](https://oasis.hq.fan/) Registrierung an – ohne Browser.

Pro Adresse: Bestätigungsmail anfordern → Link aus dem Postfach holen → E-Mail
verifizieren → reCAPTCHA lösen → Registrierung abschließen.

---

## 1. Installieren

```bash
npm install
```

(Beim ersten Start lädt eine Bibliothek einmalig etwas nach – kurz warten.)

---

## 2. Einrichten

Es gibt drei Dateien zum Ausfüllen:

### `config.json`

Nur zwei Dinge musst du eintragen:

```json
"capsolver_api_key": "CAP-DEIN-KEY",
"imap": {
  "host": "imap.deinprovider.de",
  "user": "postfach@deinedomain.de",
  "password": "deinpasswort"
}
```

- **`capsolver_api_key`** – dein Key von [capsolver.com](https://capsolver.com) (löst das Captcha).
- **`imap`** – das Postfach, in dem die Bestätigungsmails ankommen.

Alles andere in der Datei (Artist-/Page-IDs, Städte-Liste, Umfrage-Antworten) ist
bereits korrekt für Oasis voreingestellt und muss nicht angefasst werden.

### `input.csv`

Eine Zeile pro Person. Pflichtspalten: `Email`, `FirstName`, `LastName`,
`DateOfBirth` (Format `JJJJ-MM-TT`), `CountryCallingCode` (ohne `+`, z. B. `49`), `PhoneNumber`.

```csv
Email,FirstName,LastName,DateOfBirth,CountryCallingCode,PhoneNumber
john@example.com,John,Doe,2000-09-09,49,1701234567
```

Wenn jede Adresse ein eigenes Postfach hat, kannst du zusätzlich die Spalten
`Imap Host,Imap Port,Imap User,Imap Password` anhängen – die überschreiben dann
die `config.json` für diese Zeile. Sonst leer lassen oder weglassen.

### `proxies.txt`

Eine Proxy pro Zeile als `HOST:PORT:USER:PASS` (Login-Teil optional). Leere Datei
= ohne Proxy.

```
proxy.example.com:7777:benutzer:passwort
```

---

## 3. Starten

```bash
npm start
```

Ein erfolgreicher Lauf sieht so aus:

```
[SUCCESS] [john@example.com] Verification email requested
[SUCCESS] [john@example.com] Verification link received
[SUCCESS] [john@example.com] Email verified
[SUCCESS] [john@example.com] reCAPTCHA token received
[INFO   ] [john@example.com] Cities (ranked): Munich > Paris > Slane
[SUCCESS] [john@example.com] Registered for Register for Oasis Live '27
```

`Registered` erscheint nur, wenn der Server die Anmeldung wirklich bestätigt.
Jeder Lauf schreibt zusätzlich ein Log nach `logs/`.

---

## Gut zu wissen

- **Städte:** Pro Anmeldung werden 3 Städte zufällig gewählt und gerankt. Das
  Musik-Quiz („Which Oasis album…") bleibt fest auf der richtigen Antwort.
- **Standort:** Wird automatisch aus der Proxy-IP ermittelt – nichts einzutragen.
- **Gleiche E-Mail nochmal:** Kein Problem, der Kontakt wird aktualisiert (keine
  Duplikate) – der letzte Lauf zählt.

## Wenn etwas klemmt

| Meldung im Log                     | Ursache / Lösung                                              |
| ---------------------------------- | ------------------------------------------------------------- |
| `HTTP 403`                         | Proxy-IP verbrannt – Retries nehmen automatisch den nächsten  |
| `No verification link received`    | Mail nicht angekommen oder im falschen Ordner (`sender_filter`)|
| `/confirm did not return OK`       | Captcha-Score zu niedrig (`recaptcha.action` prüfen) oder Feld leer |
| `CapSolver: ERROR_…`               | Kein Guthaben oder falscher Key (Balance wird beim Start geloggt) |

---

## Optionale Einstellungen

Diese Werte haben sinnvolle Standardwerte und müssen **nicht** in der Config
stehen. Nur eintragen, wenn du sie ändern willst:

| Schlüssel                | Standard | Bedeutung                          |
| ------------------------ | -------- | ---------------------------------- |
| `proxy_type`             | `http`   | `http`, `https`, `socks5`, `socks4`|
| `max_concurrent_tasks`   | `2`      | Wie viele Anmeldungen parallel     |
| `delay_between_tasks_ms` | `3000`   | Pause zwischen zwei Starts         |
| `retries_per_task`       | `2`      | Versuche pro Adresse               |
| `location`               | auto     | Fester Standort statt Auto-Erkennung |
