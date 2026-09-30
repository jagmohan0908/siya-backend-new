// Matches the current app kit definitions. Weekly products are excluded from a
// daily streak; users must never be encouraged to use a weekly product daily.
export const habitFrequencies = {
  psoria_oil:'twiceDaily',psoria_shampoo:'twiceWeekly',psoria_lotion:'onceDaily',psoria_body_wash:'onceDaily',
  acne_face_wash:'twiceDaily',acne_spot_corrector:'onceDaily',acne_moisturizer:'onceDaily',
  hair_scalp_serum:'twiceWeekly',hair_shampoo:'twiceWeekly',hair_growth_serum:'onceDaily',
  vitiligo_cream:'twiceDaily',vitiligo_tablet_fast:'onceDaily',vitiligo_tablet_vitals:'onceDaily',
};
export function isPerfectDay(entry,ids,frequencies=habitFrequencies) {
  const daily=ids.filter(id=>frequencies[id]!=='twiceWeekly');
  return daily.length>0 && daily.every(id=>frequencies[id]==='twiceDaily'
    ? entry?.completedHabitTimes?.[`${id}_morning`]===true && entry?.completedHabitTimes?.[`${id}_evening`]===true
    : entry?.completedHabits?.[id]===true);
}
