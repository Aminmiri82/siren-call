return {
  recipients = everyone() - (role("L1") + role("L2")) - joined_after("2026-09-18"),
  message = "Class is cancelled"
}
