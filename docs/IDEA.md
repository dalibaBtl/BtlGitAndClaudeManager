# BTL Git and Claude Manager

vizualizer git repo a vyhledávač claude sessions
GUI anglicky. níže některé funkce nazývám CZ, ale v GUI bude pouze EN.

## Layout

Tři sloupce:
Vlevo stromová struktura vybraných složek až do úrovně, kde je repo - Folder tree
Uprostřed stromová struktura složek a souborů repa - Repo tree
Vpravo zobrazení diffu - Diff vizualizer
Dole pod Repo tree terminál

## Folder tree

User vybere folder - prohledá se jeho subfoldery - končí se na úrovni, kde je repo
Kde je repo, tak se probarví, kde není, je šedivé, ale jde rokliknout hlouběji, pokud obsahuje další podsložky
Nezobrazuje soubory, ale Claude sessions.

### Folder tree functions

Add folder - lze přidat libovolné množství horních uzlů, nebo klidně celé disky (bude to hodne náročné na performance? Varovat?)
Clone repo, New repo - kontextově na folderu ve stromové struktuře, kde ještě repo není
Na Claude Code sessions kontextově Open on terminal a open on external terminal
Na všech folderech i open in File manager
Hide folder - odebere ze zobrazení. Nemaže z disku.
Repo za sebou má v závorce počet necommitnutých souborů
Filtrace
Zobrazit jen "špinavá" repa

## Repo tree

Stromová struktura souborů v repu
Kliknutím na soubor se zobrazí jeho diff
V kontextovém menu Stash

### Repo tree functions

Stash all
Prepare commit
Commit
Filtrace
Jen změněno - jinak zobrazuje vše a barevně rozlišuje, co je zmeneno
Hide ignore - jinak zobrazuje i ignore fily, jen prošedle
KOntextově na filu / složce
Stash
Ignore - přidá folder či soubor do gitignore. Od té chvíle nebudou v commitech (i kdyby předtím byly)
Open in external app
Pokud by byla claude session v podsložce, tak jí taky zobrazí (claude code oranžovou)
Jednotlivé commity budou jako sloupce vedle sebe se scroolováním pod nimy. Sloupce jsou ty stromové struktury
Push/pull funkcionalita na github
Branch selector

### Proč je Commit rozdělen na prepare a commit?

Protože chci, aby claude mohl pořipravit commity zvnější. připraví file s commentem a příkaz do terminálu
Takže připravené Commity vytvoří jakousi frontu, do které jdou jak přímo z aplikace, tak muzou jít zvnejší. A naráz je vidět více připravených commitů
Následně je user "okliká" a pošle do terminálu.

## Diff view

Zobrazuje změny u souborů
MOžnost zobrazit celý soubor

## Co to bude

Primárně aplikace pro linux i windows. Spustitelný all in one file.
Abby se nabízela v manageru (mod + d) a běžela normal v okně / tilu
