// components/ConsultantProfileForm.tsx
import React from "react";
import { useFormContext } from "react-hook-form";
import { ConsultantProfile } from "../schemas/userSchema";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const ConsultantProfileForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<ConsultantProfile>();

  return (
    <form onSubmit={handleSubmit(onNext)}>
      <div>
        <label>Rating</label>
        <input type="number" {...register("rating")} />
        {errors.rating && <p>{errors.rating.message}</p>}
      </div>
      <div>
        <label>Specialization</label>
        <input {...register("specialization")} />
      </div>
      <div>
        <label>Experience</label>
        <input {...register("experience")} />
      </div>
      <div>
        <label>Location</label>
        <input {...register("location")} />
      </div>
      <button type="button" onClick={onBack}>Back</button>
      <button type="submit">Next</button>
    </form>
  );
};

export default ConsultantProfileForm;