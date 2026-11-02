# Who wrote each book: an audit of all 66 (brief AQ1)

Ji (2026-11-01): "Make sure that each and every book in the Bible, within the context of its writer, is double-checked and QC'd; where alternatives exist, check them. For example, John the apostle did not write Hebrews; most likely it's Paul, but there are alternatives that need to be mentioned as well."

## Where the app says who wrote a book

1. `src/book_intros.json` (authored; merged into `app/data/context/books.json` by build.py `build_context`): per book `author`, `date`, `written` [from, to] (BC negative), audience, setting, purpose, themes, outline. `author` and `date` form the **intro line in the chapter hero** (reader.js: `author · date`) and the **About <book>** card (drawer.js, `kv('Author', …)`).
2. **Theographic per-chapter writers** (`app/data/context/NN.json`, each chapter's `w`: person ids into `app/data/people.json`) drive the **Context tab's "Writer" / "Traditionally" stat** (drawer.js `contextTab`: label "Traditionally" when `author` matches `TRADITIONAL = /^(anonymous|the chronicler|associated)|tradition|debated/i`, else "Writer"; tooltip = `author`). Some contradict the intro (Job → Moses, Ruth → Samuel, Esther → Mordecai, Hebrews → Paul shown without qualification), and Psalms and Proverbs are per chapter.
3. The current state of every book is in `.design/linkstest/authorship-current.json` (author, date, written, Theographic writers).

## The standard

For every book, the app must say, briefly and fairly:
- **What the text itself says** (named in 1:1, a superscription, "the elder", anonymous).
- **The tradition** (Jewish and early church: who said so, e.g. Papias, Irenaeus, the Talmud Bava Batra 14b–15a, Origen, Eusebius), clearly as tradition when the text does not name the writer.
- **Alternatives** where scholars seriously propose them (Hebrews: Barnabas, Apollos, Luke, Priscilla, Clement of Rome; Isaiah 40–66; the Pastorals; 2 Peter; Daniel's date; Ecclesiastes; the Pentateuch's sources), named without ridicule and without overclaiming either way. A book whose authorship is not seriously disputed says so plainly ("Paul (named in 1:1)").
- **Hebrews specifically:** the letter names no author. Lead with the traditional attribution to Paul (the Eastern church from Clement of Alexandria and Origen; the KJV's title), say it is anonymous, and name the alternatives. Do not write "most likely Paul" as a fact (scholars are divided; most modern ones doubt Paul), and never anything that could suggest John wrote it.
- Reverence rules apply (God is never one of "the people"); British spelling, sentence case, curly quotes.

## Output fields

- `author` (hero intro line and About card): **concise, at most ~95 characters**, one consistent pattern across books, following the evidence standard below: "Paul (named in 1:1)", "Author uncertain; traditionally Moses; many scholars see later sources and editing", "Author uncertain; traditionally Paul; also proposed: Barnabas, Apollos, Luke", "Peter (named in 1:1); authorship widely disputed".
- `authorNote` (new, About card only, below the hero): 1–3 sentences giving the basis: the text's own claim, the earliest witnesses, the main alternatives, and where modern scholarship mostly stands. Plain, fair, no footnote clutter.
- `date` / `written`: correct where they tie to authorship (e.g. a later author implies a later date range); keep the existing format.
- Theographic chapter writers: where they contradict the intro or state as fact what is only tradition, propose the fix: either the Context stat label/tooltip follows the intro ("Traditionally"), or an override of the per-chapter writers (Psalms by superscription; Proverbs 1–29 Solomon / 22:17–24:34 "the wise" / 25–29 Hezekiah's men copied Solomon / 30 Agur / 31 Lemuel).

## Evidence standard (Ji, 2026-11-01: "do not make anything up but look at the most reputable historians, and if authorship is not conclusive then mention that explicitly")

- **Nothing invented.** Every factual claim in `author`, `authorNote`, `date` and `written` (who is named in the text, who attributed it and when, which alternatives are proposed and by whom, the dating) must rest on a source the agent actually consulted: primary witnesses (the text itself in `app/data/bibles/kjv`; Eusebius, *Church History*; the Talmud, Bava Batra 14b–15a; Irenaeus, *Against Heresies*; the Muratorian fragment) and the most reputable modern scholarship (e.g. Raymond E. Brown, *An Introduction to the New Testament*; Carson & Moo, *An Introduction to the New Testament*; Donald Guthrie, *New Testament Introduction*; Longman & Dillard, *An Introduction to the Old Testament*; John J. Collins, *Introduction to the Hebrew Bible*; the Anchor Yale Bible Dictionary; the Oxford Bible Commentary; Encyclopaedia Britannica). A claim that cannot be sourced is left out, not guessed.
- **Say plainly when it is not conclusive.** Where the text does not name its writer, or where reputable scholars disagree about the named or traditional writer, the author line says so explicitly with one fixed wording: it starts **"Author uncertain;"** (anonymous books and those whose tradition is seriously disputed) and then gives the tradition and the alternatives, e.g. "Author uncertain; traditionally Paul; also proposed: Barnabas, Apollos, Luke". Where the text names the writer and that is broadly accepted, it says so plainly ("Paul (named in 1:1)"). Where the text names a writer but modern scholars widely dispute it (e.g. 2 Peter, the Pastorals), the line says both: "Peter (named in 1:1); authorship widely disputed".
- **Sources kept.** The agreed sources for every book are saved in `.design/authorship-sources.json` (book → claims → sources) so any line can be traced; nothing in the app shows citations.
