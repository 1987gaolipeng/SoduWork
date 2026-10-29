import unittest
from app.services.task_execution_options import substrate_options

class TaskLocationsTests(unittest.TestCase):
    def seat(self, client, runner):
        return {"cli":"pi","online":True,"clientId":client,"runnerId":runner,
                "machineKey":client,"host":client,"remote":True}
    def test_own_connected_runner_is_local(self):
        row=substrate_options([self.seat("mine","r1")],[],"mine")[0]
        self.assertEqual(row["locationMode"],"local")
        self.assertEqual(row["locations"][0]["mode"],"local")
    def test_other_device_stays_remote(self):
        row=substrate_options([self.seat("other","r2")],[],"mine")[0]
        self.assertEqual(row["locationMode"],"remote")
    def test_multiple_devices_are_not_silently_forced_local(self):
        row=substrate_options([self.seat("mine","r1"),self.seat("other","r2")],[],"mine")[0]
        self.assertEqual(row["locationMode"],"mixed")
    def test_legacy_without_viewer_keeps_its_existing_contract(self):
        row=substrate_options([self.seat("mine","r1")],[])[0]
        self.assertEqual(row["locationMode"],"remote")

if __name__=="__main__":unittest.main()
