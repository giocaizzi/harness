---
type: llm
---

Judge the Python the session wrote (its Write and Edit calls) for the email channel. Pass when all of these hold: email is a concrete class beside `SlackSender` (for example `EmailSender` in its own module) using `smtplib`; nothing introduces an abstract base class, `abc.ABC`, a base class both senders inherit from, a `*Factory`, `*Manager`, `*Helper` or registry to choose senders; if a `Protocol` appears, it is declared where the senders are consumed (for example in `cli.py`, or a function that sends to every channel), not as a hierarchy the senders subclass; every new import is absolute and imports a module, never a class (`from notify import email`, not `from .email import EmailSender` or `from notify.email import EmailSender`); `main` reads the SMTP settings from the environment and builds both senders. Fail when any of these is broken, even if the feature works.
