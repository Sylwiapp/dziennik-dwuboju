# Plan rozwoju

## Etap 1 — pokaz trenerowi

Gotowe:

- konta e-mail/hasło i potwierdzanie poczty,
- trwałe role trener/zawodnik,
- jednorazowe zaproszenie zawodnika,
- wielu zawodników przypisanych do trenera,
- plan, dziennik, rekordy i analiza,
- przejście z dnia planu bezpośrednio do realizacji,
- synchronizacja telefonu i komputera,
- kopia danych do pliku,
- widok mobilny i wydruk planu.

Przed spotkaniem:

- utworzyć projekt Supabase i opublikować stronę,
- założyć testowe konto trenera i zawodnika,
- połączyć je zaproszeniem,
- wczytać dane przykładowe i przejść pełną ścieżkę.

## Etap 2 — po pierwszym spotkaniu

Najpierw zebrać uwagi trenera dotyczące nazw, kolejności pól i faktycznego
przebiegu układania tygodnia. Następnie:

1. kopiowanie całego mikrocyklu i dnia,
2. biblioteka ćwiczeń z wyszukiwaniem i domyślnym rekordem bazowym,
3. oznaczenie jednostki jako wykonana/pominięta,
4. komentarze trenera i zawodnika,
5. masa ciała i samopoczucie w dniu treningu,
6. wykres tonażu, średniego obciążenia, intensywności i masy ciała,
7. powiadomienie o opublikowaniu planu.

## Etap 3 — właściwa wersja badawcza

1. Przenieść dokument JSON do relacyjnych tabel:
   `microcycles`, `plan_days`, `plan_exercises`, `training_sessions`,
   `session_exercises`, `records`.
2. Dodać historię zmian planu i rejestrować, kto wykonał zmianę.
3. Dodać profil zawodnika, wyniki zawodów i testów.
4. Dodać TEI i analizę force–velocity, jeśli będzie częścią badań.
5. Eksport CSV/XLSX do dalszej analizy statystycznej.
6. Testy automatyczne reguł uprawnień i obliczeń.
7. Zgody, retencja danych, usunięcie konta i dokumentacja RODO.

## Decyzje wymagające opinii trenera

- czy plan przypisuje się indywidualnie, czy najpierw grupie,
- czy zawodnik może zmieniać ćwiczenie z planu,
- które części treningu mają osobny czas i RPE,
- jak traktować nieudane podejścia w tonażu,
- czy ACWR ma używać wszystkich jednostek czy tylko wybranych kompleksów,
- które wykresy faktycznie wpływają na decyzje treningowe.

