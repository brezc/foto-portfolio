# Bea Krä · fotografie

Web: https://brezc.github.io/foto-portfolio/

Osobní web s fotkami. Úvodní stránka ukazuje alba, kliknutím se otevře album a v něm prohlížeč fotek.
Web je v angličtině, protože psací stroje (a tím i písmo Rat Typewriter) neznají českou diakritiku.

## Jednou na začátku

V terminálu ve složce webu:

```
npm install
```

## Přidání nového alba

1. Ve složce `alba/` vytvoř podsložku, třeba `2025-09 Iceland`. Datum na začátku názvu se na webu nezobrazí, jen drží pořádek na disku.
2. Nakopíruj do ní fotky (JPEG, PNG, TIFF nebo WebP). Fotky jdou na webu v abecedním pořadí názvů souborů. Když chceš jiné pořadí, přejmenuj je (`01.jpg`, `02.jpg`…).
3. Když chceš, přidej do složky soubor `album.txt`:

   ```
   title: Iceland
   date: September 2025
   place: Westfjords
   description: Two weeks cycling around the island.
   cover: DSC_0412.jpg
   ```

   Texty piš anglicky, poli můžeš říkat i česky (`název`, `datum`, `místo`, `popis`, `obal`). Všechno je nepovinné. Bez názvu se použije název složky, bez data měsíc focení z fotek, bez obalu první fotka. Popis může mít víc odstavců, odděl je prázdným řádkem.
4. Spusť `npm run fotky`. Skript udělá z originálů webové verze. Poprvé to chvíli trvá, příště zpracuje jen nové nebo změněné fotky.
5. Spusť `npm run nahled` a otevři http://localhost:8080.

Alba se řadí od nejnovějšího podle data focení.

**Skrytí alba:** přejmenuj složku tak, aby začínala podtržítkem (`_Iceland`), a spusť `npm run fotky`.
**Smazání alba:** smaž složku z `alba/` a spusť `npm run fotky`.

Originály ve složce `alba/` nech. Web se z nich staví a fotka, která z `alba/` zmizí, zmizí při dalším `npm run fotky` i z webu.

## Co se děje s fotkami

- Z každé fotky vzniknou tři velikosti (640, 1280 a 2400 px delší strana) ve formátu WebP. Prohlížeč si stáhne jen tu, kterou potřebuje.
- Originály na GitHub nejdou, složka `alba/` je v `.gitignore`.
- Z webových verzí se maže všechna metadata včetně GPS. Na webu se zobrazí jen údaje o expozici (fotoaparát, ohnisko, clona, čas, ISO), dají se vypnout v `site.json`.
- Barvy z profilů jako Adobe RGB nebo Display P3 se převedou do sRGB, aby fotky vypadaly na webu stejně jako u tebe.
- iPhone fotky ve formátu HEIC skript neumí, vyexportuj je jako JPEG.

Jedna fotka zabere na webu zhruba 0,5 až 1 MB. GitHub Pages unese web do 1 GB, tedy řádově tisíc fotek.

## Nastavení webu (`site.json`)

| Klíč | Co dělá |
| --- | --- |
| `jmeno` | Jméno v hlavičce a patičce |
| `symbol` | Symbol vedle jména (třeba `ᓚᘏᕐᐷ`). Prázdné uvozovky ho schovají. |
| `nadpis` | Název webu v záložce prohlížeče (na stránce se nezobrazuje) |
| `pismo` | Písmo celého webu: `tox-typewriter`, `rat-typewriter`, `x-typewriter`, `orange-typewriter`, `uncle-typewriter`, `psaci-stroj` (Special Elite), `podpis` (krasopis Pinyon Script) nebo `klasicke`. Licence písem jsou v `assets/fonts/LICENCE.md`. |
| `pismoJmena` | Písmo jen pro jméno v hlavičce (stejné možnosti jako `pismo`). |
| `uvod` | Krátký text nad alby na úvodní stránce (může zůstat prázdný) |
| `instagram` | Uživatelské jméno nebo celý odkaz, v patičce se objeví odkaz |
| `email` | E-mail do patičky |
| `zobrazitExif` | `true` nebo `false`: údaje o expozici v prohlížeči fotek |
| `plynuleScrollovani` | `true` nebo `false`: jemně dobíhající scroll kolečkem myši |

Po změně spusť znovu `npm run fotky`.

## Zveřejnění na GitHubu

Web je v repozitáři https://github.com/brezc/foto-portfolio a GitHub Pages ho publikuje z větve `main`.

Pokaždé, když přidáš fotky:

```
npm run fotky
git add -A
git commit -m "Nové album"
git push
```

Web se aktualizuje do pár minut.

Když změníš jméno nebo písmo jména v `site.json`, spusť ještě `npm run logo`. Jméno v hlavičce je vyrobené jako logo z písma Uncle Typewriter, protože soubor toho písma na web dávat nesmí (viz `assets/fonts/LICENCE.md`).

## Ovládání pro návštěvníky

- Na úvodní stránce jsou alba založená za sebou jako složky v přihrádce, aktuální je vepředu vlevo. Scrollováním (nebo šipkami na klávesnici) se jimi listuje. Klik na něj ho otevře, klik na jiné album nebo jeho název vpravo dole ho přisune doprostřed.
- Tři čárky vpravo nahoře otevřou přes celou obrazovku menu se všemi alby, vyjede zprava. Najetím myší se vedle ukáže obal alba. V albu je vedle čárek jeho název.
- Slunce (ve tmavém režimu měsíc) vedle čárek přepíná světlý a tmavý režim. Výchozí je tmavý, volba se pamatuje.
- Kliknutí na fotku ji otevře přes celou obrazovku.
- Fotky v prohlížeči leží pod sebou a scrolluje se jimi plynule kolečkem, touchpadem, tažením prstu nebo šipkami. Po zastavení se dorovnají na celou fotku. Za fotkou je vidět rozmazaná stránka alba.
- Esc, tažení fotky nahoru či dolů nebo tlačítko Zpět v prohlížeči prohlížeč zavře.
- Každá fotka má vlastní adresu (např. `…/#/island/12`), dá se poslat odkazem.

## ASCII obrázky

Srdíčko „<333“ v patičce je v `assets/js/ascii.js`. Je z Braillova písma a web ho kreslí po tečkách, takže vypadá všude stejně. Když chceš jiný obrázek, vlož ho tam místo stávajícího (každý řádek musí mít stejný počet znaků).
