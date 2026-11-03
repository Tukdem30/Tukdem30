/** Task categories. The value is stored on each task; the label is shown on the page. */
export const CATEGORIES = [
  { value: "home-repair", label: "Home repair" },
  { value: "kitchen-equipment", label: "Commercial kitchen equipment" },
  { value: "electronics", label: "Electronics repair" },
  { value: "automotive", label: "Automotive repair" },
  { value: "woodwork", label: "Woodwork & renovation" },
  { value: "yard", label: "Yard & outdoor" },
  { value: "cleaning", label: "Cleaning" },
  { value: "moving", label: "Moving & hauling" },
  { value: "tech-help", label: "Technology help" },
  { value: "tutoring", label: "Tutoring & learning" },
  { value: "transport", label: "Rides & transportation" },
  { value: "pet-care", label: "Pet care" },
  { value: "errands", label: "Errands & shopping" },
  { value: "companionship", label: "Companionship" },
  { value: "other", label: "Other" },
] as const;

export const CATEGORY_VALUES = CATEGORIES.map((c) => c.value) as [string, ...string[]];
