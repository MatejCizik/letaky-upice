# Letáky Úpice

Webová aplikace pro koordinaci roznosu letáků po ulicích Úpice.

## Spuštění v XAMPP

1. Rozbalte složku `letaky-upice` do `C:\xampp\htdocs\letaky-upice`.
2. V XAMPP Control Panel spusťte **Apache**.
3. Protože databáze už je připojená k projektu Supabase, není třeba měnit `config.js`.
4. Při úplně prvním spuštění otevřete jednorázově:
   `http://localhost/letaky-upice/setup.html`
5. Vytvořte prvního administrátora. Doporučené údaje pro tuto instalaci:
   - uživatelské jméno: `admin`
   - zobrazované jméno: `Administrátor`
   - heslo: `admin1` (po otestování doporučujeme používat silnější heslo)
6. Po vytvoření prvního účtu se `setup.html` serverově zablokuje a další účet přes něj vytvořit nejde.
7. Běžný web je na:
   `http://localhost/letaky-upice/`

## Přihlašování

Aplikace nepoužívá e-mailové účty. Přihlašuje se pouze **uživatelským jménem a heslem**.

Veřejná registrace neexistuje. Nové účty vytváří administrátor v záložce **Admin → Účty**. Admin může uživatele:
- vytvořit,
- povýšit na administrátora / odebrat admin roli,
- zablokovat nebo znovu aktivovat,
- nastavit nové heslo,
- smazat.

## Bezpečnost

- Hesla se do databáze neukládají v čitelné podobě; jsou hashovaná pomocí bcrypt/pgcrypto.
- V prohlížeči není žádný Supabase `service_role` ani jiný tajný administrátorský klíč.
- Přímé čtení a zápis do tabulek z veřejného klienta je zakázaný.
- Každá změna ulice i správa uživatelů ověřuje aplikační session token na serverové straně.
- Session je platná maximálně 30 dní a odhlášení ji odstraní.
- Pro veřejné nasazení používejte HTTPS.

## Stavy ulic

- **Volná** – může si ji převzít kterýkoliv přihlášený uživatel.
- **Roznáší se** – ulice je zamčená pro uživatele, který ji převzal.
- **Rozneseno** – dokončená ulice.

Uživatel může měnit pouze svoje ulice. Administrátor může upravit nebo uvolnit jakoukoliv ulici.

## Synchronizace

Web každých několik sekund automaticky načte aktuální stav ze společné Supabase databáze, takže změny ostatních uživatelů se průběžně projeví všem přihlášeným.

## Mapová data

Ulice se načítají z OpenStreetMap přes Overpass API a úseky se seskupují podle názvu ulice.


## Mapa V4
Mapa používá MapLibre GL místo Leafletu. Podklad OpenStreetMap se skládá ve WebGL canvasu a interaktivní ulice jsou jedna GeoJSON vrstva seskupená podle názvu.


## Verze V5
- přehlednější admin dashboard
- přehled výkonu uživatelů
- export aktuálního přehledu do PDF
- PDF obsahuje počty hotových, rozpracovaných a volných ulic a výkon uživatelů


## V5.1
- Opraven export PDF: používá pdfMake přímo z dat, ne screenshot skrytého HTML.
- Opraven problém s prázdnou stránkou PDF.
- Zachována tisková záloha pro případ nedostupnosti PDF knihovny.


## Verze V6
- záložka Moje ulice pro každého uživatele
- administrátorský Log historie změn
- kompletní reset roznosu
- admin může měnit login i zobrazované jméno
- každý uživatel si může změnit vlastní heslo

Databázové změny už byly nasazeny do připojeného Supabase projektu.
