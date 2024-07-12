import React, { useState, useEffect } from "react";
import { useFormContext } from "react-hook-form";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const PreferredScheduleForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { handleSubmit, watch, setValue } = useFormContext();
  const scheduleType = watch("scheduleType");
  const [weeklySlots, setWeeklySlots] = useState<
    Record<string, Array<{ startTime: string; endTime: string }>>
  >({});
  const [customSlots, setCustomSlots] = useState<
    Record<string, Array<{ startTime: string; endTime: string }>>
  >({});

  useEffect(() => {
    setValue("weeklySlots", weeklySlots);
  }, [weeklySlots, setValue]);

  useEffect(() => {
    setValue("customSlots", customSlots);
  }, [customSlots, setValue]);

  const handleAddWeeklySlot = (day: string) => {
    setWeeklySlots((prev) => ({
      ...prev,
      [day]: [...(prev[day] || []), { startTime: "", endTime: "" }],
    }));
  };

  const handleUpdateWeeklySlot = (
    day: string,
    index: number,
    field: "startTime" | "endTime",
    value: string
  ) => {
    setWeeklySlots((prev) => ({
      ...prev,
      [day]: prev[day].map((slot, i) =>
        i === index ? { ...slot, [field]: value } : slot
      ),
    }));
  };

  const handleDeleteWeeklySlot = (day: string, index: number) => {
    setWeeklySlots((prev) => ({
      ...prev,
      [day]: prev[day].filter((_, i) => i !== index),
    }));
  };

  const handleAddCustomSlot = (day: Date) => {
    const dateString = day.toISOString().split("T")[0];
    setCustomSlots((prev) => ({
      ...prev,
      [dateString]: [
        ...(prev[dateString] || []),
        { startTime: "", endTime: "" },
      ],
    }));
  };

  const handleUpdateCustomSlot = (
    dateString: string,
    index: number,
    field: "startTime" | "endTime",
    value: string
  ) => {
    setCustomSlots((prev) => ({
      ...prev,
      [dateString]: prev[dateString].map((slot, i) =>
        i === index ? { ...slot, [field]: value } : slot
      ),
    }));
  };

  const handleDeleteCustomSlot = (dateString: string, index: number) => {
    setCustomSlots((prev) => {
      const updatedSlots = {
        ...prev,
        [dateString]: prev[dateString].filter((_, i) => i !== index),
      };

      // If there are no more slots for this day, remove the day entirely
      if (updatedSlots[dateString].length === 0) {
        delete updatedSlots[dateString];
      }

      return updatedSlots;
    });
  };

  return (
    <form onSubmit={handleSubmit(onNext)} className="w-full max-w-md">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Preferred Schedule</CardTitle>
          <CardDescription>
            Choose how you'd like to schedule your appointments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            defaultValue="weekly"
            onValueChange={(value) => setValue("scheduleType", value)}
          >
            <div className="flex items-center justify-between">
              <Label htmlFor="weekly" className="font-medium">
                Weekly Recurring
              </Label>
              <RadioGroupItem id="weekly" value="weekly" />
            </div>
            <div
              className={`grid gap-4 mt-4 ${
                scheduleType !== "weekly"
                  ? "opacity-50 pointer-events-none"
                  : ""
              }`}
            >
              {[
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
              ].map((day) => (
                <div key={day} className="grid gap-2">
                  <Label>{day}</Label>
                  {weeklySlots[day]?.map((slot, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-5 gap-2 items-center"
                    >
                      <Input
                        type="time"
                        value={slot.startTime}
                        onChange={(e) =>
                          handleUpdateWeeklySlot(
                            day,
                            index,
                            "startTime",
                            e.target.value
                          )
                        }
                        className="col-span-2"
                      />
                      <Input
                        type="time"
                        value={slot.endTime}
                        onChange={(e) =>
                          handleUpdateWeeklySlot(
                            day,
                            index,
                            "endTime",
                            e.target.value
                          )
                        }
                        className="col-span-2"
                      />
                      <TrashIcon
                        className="w-5 h-5 cursor-pointer"
                        onClick={() => handleDeleteWeeklySlot(day, index)}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleAddWeeklySlot(day)}
                  >
                    Add Slot
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-6">
              <Label htmlFor="custom" className="font-medium">
                Custom Schedule
              </Label>
              <RadioGroupItem id="custom" value="custom" />
            </div>
            <div
              className={`grid gap-4 mt-4 ${
                scheduleType !== "custom"
                  ? "opacity-50 pointer-events-none"
                  : ""
              }`}
            >
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">
                    Pick dates
                    <CalendarDaysIcon className="ml-auto h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="multiple"
                    selected={Object.keys(customSlots).map(
                      (dateString) => new Date(dateString)
                    )}
                    onSelect={(days) => {
                      if (days) {
                        const newCustomSlots = { ...customSlots };
                        days.forEach((day) => {
                          const dateString = day.toISOString().split("T")[0];
                          if (!newCustomSlots[dateString]) {
                            newCustomSlots[dateString] = [
                              { startTime: "", endTime: "" },
                            ];
                          }
                        });
                        // Remove dates that are not selected anymore
                        Object.keys(newCustomSlots).forEach((dateString) => {
                          if (
                            !days.some(
                              (day) =>
                                day.toISOString().split("T")[0] === dateString
                            )
                          ) {
                            delete newCustomSlots[dateString];
                          }
                        });
                        setCustomSlots(newCustomSlots);
                      }
                    }}
                    className="rounded-md border"
                  />
                </PopoverContent>
              </Popover>
              {Object.entries(customSlots).map(([dateString, slots]) => (
                <div key={dateString} className="grid gap-2">
                  <Label>{new Date(dateString).toDateString()}</Label>
                  {slots.map((slot, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-5 gap-2 items-center"
                    >
                      <Input
                        type="time"
                        value={slot.startTime}
                        onChange={(e) =>
                          handleUpdateCustomSlot(
                            dateString,
                            index,
                            "startTime",
                            e.target.value
                          )
                        }
                        className="col-span-2"
                      />
                      <Input
                        type="time"
                        value={slot.endTime}
                        onChange={(e) =>
                          handleUpdateCustomSlot(
                            dateString,
                            index,
                            "endTime",
                            e.target.value
                          )
                        }
                        className="col-span-2"
                      />
                      <TrashIcon
                        className="w-5 h-5 cursor-pointer"
                        onClick={() =>
                          handleDeleteCustomSlot(dateString, index)
                        }
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleAddCustomSlot(new Date(dateString))}
                  >
                    Add Slot
                  </Button>
                </div>
              ))}
            </div>
          </RadioGroup>
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button type="button" onClick={onBack} variant="outline">
            Back
          </Button>
          <Button type="submit" variant="night">
            Next
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
};

function CalendarDaysIcon(props: React.JSX.IntrinsicAttributes & React.SVGProps<SVGSVGElement>) {
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
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
      <path d="M16 18h.01" />
    </svg>
  );
}

function TrashIcon(props) {
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
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

export default PreferredScheduleForm;
