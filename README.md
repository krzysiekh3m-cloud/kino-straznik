# Strażnik biletów — Diuna: Część trzecia, IMAX, Helios Gdynia

Co kilka minut sprawdza repertuar Heliosa (Centrum Riviera, Gdynia) i wysyła powiadomienie na telefon (ntfy), gdy:
- pojawi się **nowy seans IMAX** w dniach **26–30.12.2026**,
- na seansie, który był wyprzedany lub prawie wyprzedany, **zwolnią się miejsca**.

Liczą się tylko **dobre miejsca: od 7. rzędu wzwyż** (rząd 1 jest najbliżej ekranu), bez miejsc dla wózków. W powiadomieniu widać, w których rzędach są wolne miejsca, np. `rz. 9: 4, rz. 12: 2`. „Prawie wyprzedany” oznacza mniej niż 10 dobrych miejsc. Powiadomienie o zwolnionych miejscach przychodzi najwyżej raz na 30 minut na dany seans.

W godzinach **23:00–7:00** nic nie wysyła. Zebrane w nocy zmiany przychodzą rano w jednym powiadomieniu, razem z aktualną liczbą wolnych miejsc. Kliknięcie w powiadomienie otwiera stronę zakupu biletów.

**Czy strażnik żyje:** codziennie ok. 7:00 przychodzi ciche „Strażnik Diuny: żyję” z aktualnym stanem seansów. Brak tego meldunku rano = padł cron-job.org, GitHub albo skrypt. Jeśli Helios nie odpowiada (albo zmienił stronę) dłużej niż godzinę, przychodzi „Strażnik Diuny NIE DZIAŁA” (najwyżej raz na dobę), a po naprawie „znów działa”.

Ustawienia (daty, pierwszy rząd, cisza nocna, próg miejsc) są w `CONFIG` na górze `straznik.js`.

## Uruchomienie (jednorazowo)
1. Zainstaluj aplikację **ntfy** na telefonie (Google Play / App Store).
2. W aplikacji: **+** → *Subscribe to topic* → wpisz trudną do zgadnięcia nazwę, np. `diuna-gdynia-x7k2q9`. Kanały ntfy są publiczne: kto zna nazwę, ten widzi powiadomienia, więc nie wybieraj czegoś prostego.
3. W tym repo na GitHubie: **Settings → Secrets and variables → Actions → New repository secret**, nazwa `NTFY_TOPIC`, wartość = nazwa kanału z punktu 2.
4. Zakładka **Actions** → *Strażnik Diuny IMAX* → **Run workflow**. Po chwili na telefonie powinno pojawić się „Strażnik Diuny IMAX działa”.

Od tej pory działa sam co ~5 minut (w każdym przebiegu 4 sprawdzenia co minutę).

## Lokalnie (test)
```
DRY_RUN=1 node straznik.js          # Linux / Git Bash
$env:DRY_RUN=1; node straznik.js   # PowerShell
```
