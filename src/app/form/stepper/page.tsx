"use client";
// Import necessary libraries
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, SubmitHandler, useForm } from "react-hook-form";
import { z } from "zod";

import { Label } from "@/components/ui/label";
import { CrownIcon } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Define your form schemas using Zod
const UserSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email address"),
  phoneNumber: z.string().regex(/^\d+$/, "Phone number must be a number"),
});

const UserWithRoleSchema = UserSchema.extend({
  role: z.enum(["Consultee", "Consultant", "Staff", "Admin"]),
});

const ConsultantSchema = z.object({
  specialization: z.string().min(1, "Specialization is required"),
  experience: z.string().regex(/^\d+$/, "Experience must be a number"),
  expertiseBackground: z.string().min(1, "Expertise background is required"),
  location: z.string().min(1, "Location is required"),
});

const StaffAdminSchema = z.object({
  companyPassword: z.string().min(1, "Company password is required"),
});

type User = z.infer<typeof UserSchema>;
type UserWithRole = z.infer<typeof UserWithRoleSchema>;
type Consultant = z.infer<typeof ConsultantSchema>;
type StaffAdmin = z.infer<typeof StaffAdminSchema>;

// Update your form component
export default function UserOnboarding() {
  const totalSteps = 3;
  const [step, setStep] = useState(1);
  const [roleError, setRoleError] = useState(false);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phoneNumber: "",
    specialization: "",
    experience: "",
    expertiseBackground: "",
    location: "",
    companyPassword: "",
    role: "",
  });

  const {
    handleSubmit: handleStep1Submit,
    control: step1Control,
    formState: { errors: step1Errors },
  } = useForm<User>({
    resolver: zodResolver(UserSchema),
  });

  const {
    handleSubmit: handleStep2Submit,
    control: step2Control,
    formState: { errors: step2Errors },
  } = useForm<UserWithRole>({
    resolver: zodResolver(UserWithRoleSchema),
  });

  const {
    handleSubmit: handleStep3Submit,
    control: step3Control,
    formState: { errors: step3Errors },
  } = useForm<Consultant | StaffAdmin>({
    resolver: zodResolver(
      formData.role == "Consultant" ? ConsultantSchema : StaffAdminSchema
    ),
  });

  const step1SubmitHandler: SubmitHandler<User> = (data) => {
    console.log("step 1 data", data);
    setFormData({ ...formData, ...data });
    if (Object.keys(step1Errors).length === 0) {
      setStep((prevStep) => prevStep + 1);
    } else {
      console.error("Zod validation error in step 1", step1Errors);
    }
  };

  const step2SubmitHandler: SubmitHandler<UserWithRole> = (data) => {
    console.log("step 2 data", data);
    setFormData({ ...formData, ...data });
    if (Object.keys(step2Errors).length === 0) {
      setStep((prevStep) => prevStep + 1);
    } else {
      console.error("Zod validation error in step 2", step2Errors);
    }
  };

  const step3SubmitHandler: SubmitHandler<Consultant | StaffAdmin> = (data) => {
    console.log("step 3 data", data);
    setFormData({ ...formData, ...data });
    console.log("form success", formData);
    if (Object.keys(step3Errors).length === 0) {
      setStep((prevStep) => prevStep + 1);
    } else {
      console.error("Zod validation error in step 3", step3Errors);
    }
  };

  const handleNext = () => {
    console.log("step", step);
    if (step === 1) {
      handleStep1Submit(step1SubmitHandler);
    } else if (step === 2) {
      handleStep2Submit(step2SubmitHandler);
    } else if (step === 3) {
      handleStep3Submit(step3SubmitHandler);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep((prevStep) => prevStep - 1);
    }
  };

  return (
    <div className="flex flex-col min-h-screen justify-center items-center bg-slate-950">
      <div className="mt-10 mb-10 bg-white shadow-md rounded-md">
        <Card className="max-w-2xl mx-auto">
          <CardHeader>
            <CardTitle>User Onboarding Form - Step {step}</CardTitle>
            <CardDescription>
              Enter user details to create a new user
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form>
              {step === 1 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="first-name">First name</Label>
                      <Controller
                        name="firstName"
                        control={step1Control}
                        defaultValue=""
                        render={({ field }) => (
                          <div>
                            <Input {...field} placeholder="First Name" />
                            {step1Errors.firstName && (
                              <p className="text-red-500">
                                {step1Errors.firstName.message as string}
                              </p>
                            )}
                          </div>
                        )}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="last-name">Last name</Label>
                      <Controller
                        name="lastName"
                        control={step1Control}
                        defaultValue=""
                        render={({ field }) => (
                          <div>
                            <Input {...field} placeholder="Last Name" />
                            {step1Errors.lastName && (
                              <p className="text-red-500">
                                {step1Errors.lastName.message as string}
                              </p>
                            )}
                          </div>
                        )}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Controller
                      name="email"
                      control={step1Control}
                      defaultValue=""
                      render={({ field }) => (
                        <>
                          <Input {...field} placeholder="johndoe@example.com" />
                          {step1Errors.email && (
                            <p className="text-red-500">
                              {step1Errors.email.message as string}
                            </p>
                          )}
                        </>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone-number">Phone Number</Label>
                    <Controller
                      name="phoneNumber"
                      control={step1Control}
                      defaultValue=""
                      render={({ field }) => (
                        <div>
                          <Input {...field} placeholder="1234567890" />
                          {step1Errors.phoneNumber && (
                            <p className="text-red-500">
                              {step1Errors.phoneNumber.message as string}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  </div>
                </div>
              )}
              {step === 2 && (
                <div className="grid grid-cols-2 gap-4">
                  <Card
                    className="p-4 flex flex-col items-center justify-center text-center"
                    onClick={() => {
                      setFormData({ ...formData, role: "Consultee" });
                    }}
                  >
                    <LaptopIcon className="w-12 h-12 mb-2" />
                    <CardTitle>Consultee</CardTitle>
                  </Card>
                  <Card
                    className="p-4 flex flex-col items-center justify-center text-center"
                    onClick={() => {
                      setFormData({ ...formData, role: "Consultant" });
                    }}
                  >
                    <PresentationIcon className="w-12 h-12 mb-2" />
                    <CardTitle>Consultant</CardTitle>
                  </Card>
                  <Card
                    className="p-4 flex flex-col items-center justify-center text-center"
                    onClick={() => {
                      setFormData({ ...formData, role: "Staff" });
                    }}
                  >
                    <LampDeskIcon className="w-12 h-12 mb-2" />
                    <CardTitle>Staff</CardTitle>
                  </Card>
                  <Card
                    className="p-4 flex flex-col items-center justify-center text-center"
                    onClick={() => {
                      setFormData({ ...formData, role: "Admin" });
                    }}
                  >
                    <CrownIcon className="w-12 h-12 mb-2" />
                    <CardTitle>Admin</CardTitle>
                  </Card>
                </div>
              )}
              {step === 2 && roleError && (
                <p className="text-red-500">Please select a role.</p>
              )}
              {step === 3 && formData.role == "Consultant" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="specialization">Specialization</Label>
                    <Controller
                      name="specialization"
                      control={step3Control}
                      defaultValue=""
                      render={({ field }) => (
                        <div>
                          <Input
                            {...field}
                            placeholder="Enter your specialization"
                          />
                          {step3Errors.specialization && (
                            <p className="text-red-500">
                              {step3Errors.specialization.message as string}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="experience">Experience (in years)</Label>
                    <Controller
                      name="experience"
                      control={step3Control}
                      defaultValue=""
                      render={({ field }) => (
                        <div>
                          <Input {...field} pattern="[0-9]*" type="text" />
                          {step3Errors.experience && (
                            <p className="text-red-500">
                              {step3Errors.experience.message as string}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expertiseBackground">
                      Expertise Background/Educational History
                    </Label>
                    <Controller
                      name="expertiseBackground"
                      control={step3Control}
                      defaultValue=""
                      render={({ field }) => (
                        <div>
                          <Textarea
                            {...field}
                            placeholder="Type your message here."
                          />
                          {step3Errors.expertiseBackground && (
                            <p className="text-red-500">
                              {step3Errors.expertiseBackground.message as string}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="location">Location</Label>
                    <Controller
                      name="location"
                      control={step3Control}
                      defaultValue=""
                      render={({ field }) => (
                        <div>
                          <Input {...field} placeholder="Enter your location" />
                          {step3Errors.location && (
                            <p className="text-red-500">
                              {step3Errors.location.message as string}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  </div>
                </div>
              )}
              {step === 3 &&
                (formData.role == "Staff" || formData.role == "Admin") && (
                  <div className="space-y-2">
                    <Label htmlFor="companyPassword">Company Password</Label>
                    <Controller
                      name="companyPassword"
                      control={step3Control}
                      defaultValue=""
                      render={({ field }) => (
                        <div>
                          <Input {...field} type="password" />
                          {step3Errors.companyPassword && (
                            <p className="text-red-500">
                              {step3Errors.companyPassword.message as string}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  </div>
                )}
              <CardFooter className="flex justify-end gap-5 mt-5">
                {step !== 1 && (
                  <Button
                    className="w-full md:w-auto bg-gray-300 text-black"
                    type="button"
                    onClick={handleBack}
                  >
                    Back
                  </Button>
                )}
                {step < totalSteps ? (
                  <Button
                    className="w-full md:w-auto bg-black text-white"
                    type="button"
                    onClick={() => handleNext()}
                  >
                    Next
                  </Button>
                ) : (
                  <Button
                    className="w-full md:w-auto bg-black text-white"
                    type="submit"
                  >
                    Submit
                  </Button>
                )}
              </CardFooter>
            </form>
          </CardContent>
        </Card>
      </div>
      <footer className="bg-gray-800 p-4 text-center text-white">
        <p>© 2023 Company Name. All rights reserved.</p>
      </footer>
    </div>
  );
}

function LampDeskIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m14 5-3 3 2 7 8-8-7-2Z" />
      <path d="m14 5-3 3-3-3 3-3 3 3Z" />
      <path d="M9.5 6.5 4 12l3 6" />
      <path d="M3 22v-2c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v2H3Z" />
    </svg>
  );
}

function LaptopIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
    </svg>
  );
}

function PresentationIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3h20" />
      <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" />
      <path d="m7 21 5-5 5 5" />
    </svg>
  );
}
