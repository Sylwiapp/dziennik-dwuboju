# Dziennik dwuboju — wersja pilotażowa

Mobilna aplikacja do:

- planowania mikrocykli przez trenera,
- wpisywania realizacji przez zawodnika,
- liczenia objętości, tonażu, intensywności, RPE-load i ACWR,
- porównania planu z realizacją.

Interfejs działa jako strona mobilna na GitHub Pages. Konta i wspólne dane
obsługuje darmowy projekt Supabase.

## Uruchomienie online

### 1. Supabase

1. Utwórz darmowy projekt na `https://supabase.com`.
2. Wejdź w **SQL Editor**, wklej cały plik `supabase.sql` i uruchom.
3. W **Authentication > URL Configuration** ustaw:
   - Site URL: przyszły adres GitHub Pages,
   - Redirect URLs: ten sam adres oraz adres lokalny używany do testów.
4. W **Project Settings > Data API** skopiuj:
   - Project URL,
   - `anon` public key.
5. Wklej je do `config.js`.

Klucz `anon` może znajdować się w publicznym kodzie strony. Nie wolno tam
umieszczać klucza `service_role`. Dostępu do danych pilnują polityki RLS
z `supabase.sql`.

### 2. GitHub Pages

1. Umieść projekt w repozytorium GitHub.
2. W **Settings > Pages** wybierz wdrażanie z gałęzi `main`, katalog `/`.
3. Poczekaj na opublikowanie strony.
4. Wróć do konfiguracji URL w Supabase i wpisz dokładny adres strony.

### 3. Pierwsza próba

1. Trener zakłada konto z rolą **trener**.
2. W zakładce **Więcej** tworzy jednorazowy kod zaproszenia.
3. Zawodnik zakłada własne konto z rolą **zawodnik** i potwierdza e-mail.
4. Zawodnik wpisuje kod w zakładce **Więcej**.
5. Trener wybiera zawodnika i układa plan.
6. Zawodnik otwiera dzień planu i wybiera **Wpisz realizację tego dnia**.

Jeśli w Supabase włączone jest potwierdzanie adresu e-mail, użytkownik musi
najpierw kliknąć link otrzymany pocztą.

## Uruchomienie lokalne

Plików nie należy otwierać bezpośrednio przez `file://`. W katalogu projektu:

```powershell
py -3 -m http.server 8080
```

Następnie otwórz `http://127.0.0.1:8080`.

## Granice pilota

- Konto ma jedną rolę.
- Trener widzi pełny plan i dziennik przypisanych zawodników.
- Kod zaproszenia jest jednorazowy i wygasa po 7 dniach.
- Aktualizacje mają kontrolę rewizji. Jeśli dwie osoby zapiszą równocześnie,
  aplikacja nie nadpisze po cichu nowszych danych.
- Dane treningowe jednego zawodnika są na razie przechowywane jako jeden
  dokument JSON. Jest to wystarczające dla pilota, lecz przed większym
  wdrożeniem należy przenieść jednostki i ćwiczenia do osobnych tabel.

