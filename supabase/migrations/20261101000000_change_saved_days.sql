-- Saved days can be changed, not only renamed: "Change the route" plans the
-- day again in the Plan tab and "Update this day" stores its new settings,
-- option and summary. Same policy as renaming (own rows, with the season
-- pass, or anyone signed in during the test phase).

grant update (name, inputs, option, summary) on public.routes to authenticated;
