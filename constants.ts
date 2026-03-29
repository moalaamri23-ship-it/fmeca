import { RichLibrary } from './types';

export const RICH_LIBRARY: RichLibrary = {
  "Centrifugal Pumps": [ 
    { fail: "Fails to deliver flow", mode: "Impeller Binding", effect: "Loss of process flow", cause: "Foreign object", task: "Install suction strainer" }, 
    { fail: "External Leakage", mode: "Seal Failure", effect: "Spill/Fire", cause: "Face wear", task: "Flush Inspection" }, 
    { fail: "High Vibration", mode: "Bearing Wear", effect: "Pump seizure", cause: "Contamination", task: "Oil Analysis" } 
  ],
  "Electric Motors": [ 
    { fail: "Fails to Start", mode: "Winding Short", effect: "Trip", cause: "Insulation breakdown", task: "Megger Test" }, 
    { fail: "Overheating", mode: "Fan Broken", effect: "Reduced life", cause: "Fatigue", task: "Visual Inspection" } 
  ]
};
